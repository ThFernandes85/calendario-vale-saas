// Edge Function: whatsapp-alerts-worker
// Duas responsabilidades, na mesma função (menos implantação manual):
// 1. VARREDURA -- procura bookings que acabaram de entrar na janela de
//    "lembrete" (1h antes do horário) ou de "atraso" (3+ dias), e enfileira
//    um alerta por Encarregado do site (ver whatsapp_alerts_queue no
//    schema.sql). O alerta de decisão da Vale (aprovado/reprovado/
//    pendência) já é enfileirado sozinho, direto pelo trigger
//    `enqueue_vale_decision_alert` no banco -- essa função só cuida dos dois
//    que dependem de RELÓGIO, não de mudança de linha.
// 2. ENVIO -- pega as linhas 'pending' da fila e tenta mandar de verdade.
//    AINDA NÃO EXISTE conta de provedor de WhatsApp Business configurada,
//    então por enquanto isso só marca a linha como 'failed' com uma
//    mensagem explicando o motivo (nunca finge que enviou). Assim que você
//    tiver a conta (Twilio, Z-API, Meta Cloud API direto...), troque o
//    bloco marcado "TODO" mais abaixo pela chamada real -- os exemplos de
//    Twilio e Z-API já estão comentados, prontos pra descomentar.
//
// Como publicar (mesmo fluxo já usado pra admin-manage-user):
// 1. No painel do Supabase, "Edge Functions" -> "Deploy a new function",
//    nomeie como "whatsapp-alerts-worker".
// 2. Cole todo o conteúdo deste arquivo e clique em "Deploy".
//
// Como agendar (Cron Jobs do Supabase, no painel):
// 1. "Edge Functions" -> "whatsapp-alerts-worker" -> aba "Cron" (ou
//    "Integrations" -> "Cron Jobs", dependendo da versão do painel).
// 2. Agende pra rodar a cada poucos minutos (ex: a cada 5-10 min).
// 3. No cabeçalho da chamada agendada, configure
//    "Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>" -- é a mesma
//    service_role key do projeto (Project Settings -> API), não precisa
//    criar segredo novo nenhum.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const UPCOMING_WINDOW_MIN = 60;
const OVERDUE_THRESHOLD_DAYS = 3;

// Data/hora "agora" no fuso de operação (Brasil) -- as datas/horários dos
// agendamentos são sempre pensados em horário local, não UTC. Sem isso, o
// "atrasado"/"daqui a 1h" do servidor podia discordar do que a tela mostra.
function nowInSaoPaulo() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts: Record<string, string> = {};
  fmt.formatToParts(new Date()).forEach(p => { parts[p.type] = p.value; });
  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    nowMin: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10),
  };
}
function daysBetween(dateStr: string, todayStr: string) {
  const d1 = new Date(dateStr + 'T00:00:00Z').getTime();
  const d2 = new Date(todayStr + 'T00:00:00Z').getTime();
  return Math.round((d2 - d1) / 86400000);
}
function minutesToTime(min: number) {
  const h = Math.floor(min / 60).toString().padStart(2, '0');
  const m = (min % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

async function encarregadosComWhatsapp(admin: any, siteKey: string) {
  const { data: links } = await admin.from('profile_sites').select('profile_id').eq('site_key', siteKey);
  const ids = (links || []).map((l: any) => l.profile_id);
  if (!ids.length) return [] as { id: string; whatsapp: string; company_key: string }[];
  const { data: profiles } = await admin.from('profiles')
    .select('id, whatsapp, company_key')
    .in('id', ids).eq('role', 'ENCARREGADO').eq('active', true).not('whatsapp', 'is', null);
  return (profiles || []).filter((p: any) => p.whatsapp);
}

async function jaEnfileirado(admin: any, bookingId: string, eventType: string) {
  const { data } = await admin.from('whatsapp_alerts_queue').select('id')
    .eq('booking_id', bookingId).eq('event_type', eventType).limit(1);
  return !!(data && data.length);
}

async function enqueueAlert(admin: any, params: {
  siteKey: string; companyKey: string; bookingId: string; eventType: string;
  recipientProfileId: string; recipientPhone: string; messageBody: string;
}) {
  await admin.from('whatsapp_alerts_queue').insert({
    site_key: params.siteKey, company_key: params.companyKey, booking_id: params.bookingId,
    event_type: params.eventType, recipient_profile_id: params.recipientProfileId,
    recipient_phone: params.recipientPhone, message_body: params.messageBody,
  });
}

async function varredura(admin: any) {
  const { today, nowMin } = nowInSaoPaulo();
  const { data: openBookings } = await admin.from('bookings')
    .select('id, site_key, company_key, tag, om, date, start_min')
    .is('closure_status', null);
  let enfileirados = 0;
  for (const b of (openBookings || [])) {
    const isUpcoming = b.date === today && b.start_min > nowMin && b.start_min <= nowMin + UPCOMING_WINDOW_MIN;
    const isOverdue = daysBetween(b.date, today) >= OVERDUE_THRESHOLD_DAYS;
    if (!isUpcoming && !isOverdue) continue;
    // Prioriza atraso sobre lembrete se os dois baterem no mesmo booking --
    // evita mandar "lembrete" de algo que já está claramente atrasado.
    const eventType = isOverdue ? 'OVERDUE_BOOKING' : 'UPCOMING_BOOKING';
    if (await jaEnfileirado(admin, b.id, eventType)) continue;
    const recipients = await encarregadosComWhatsapp(admin, b.site_key);
    if (!recipients.length) continue;
    const msg = eventType === 'OVERDUE_BOOKING'
      ? `Atenção: limpeza ${b.tag} (OM ${b.om || '—'}) está atrasada há ${daysBetween(b.date, today)} dia(s) (data prevista ${b.date}).`
      : `Lembrete: limpeza ${b.tag} (OM ${b.om || '—'}) agendada para ${minutesToTime(b.start_min)} de hoje.`;
    for (const r of recipients) {
      await enqueueAlert(admin, {
        siteKey: b.site_key, companyKey: r.company_key, bookingId: b.id, eventType,
        recipientProfileId: r.id, recipientPhone: r.whatsapp, messageBody: msg,
      });
      enfileirados++;
    }
  }
  return enfileirados;
}

async function envio(admin: any) {
  const { data: pending } = await admin.from('whatsapp_alerts_queue').select('*').eq('status', 'pending').limit(200);
  let processados = 0;
  for (const alerta of (pending || [])) {
    // TODO: assim que tiver a conta de provedor configurada, troque este
    // bloco pela chamada real e só então marque 'sent'. Exemplos prontos
    // pra descomentar (escolha um, preencha as credenciais como variável
    // de ambiente da própria Edge Function -- nunca hardcoded aqui):
    //
    // -- Twilio --
    // const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${Deno.env.get('TWILIO_ACCOUNT_SID')}/Messages.json`, {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': 'Basic ' + btoa(`${Deno.env.get('TWILIO_ACCOUNT_SID')}:${Deno.env.get('TWILIO_AUTH_TOKEN')}`),
    //     'Content-Type': 'application/x-www-form-urlencoded',
    //   },
    //   body: new URLSearchParams({
    //     From: `whatsapp:${Deno.env.get('TWILIO_WHATSAPP_NUMBER')}`,
    //     To: `whatsapp:${alerta.recipient_phone}`,
    //     Body: alerta.message_body,
    //   }),
    // });
    //
    // -- Z-API --
    // const resp = await fetch(`https://api.z-api.io/instances/${Deno.env.get('ZAPI_INSTANCE_ID')}/token/${Deno.env.get('ZAPI_TOKEN')}/send-text`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ phone: alerta.recipient_phone, message: alerta.message_body }),
    // });

    await admin.from('whatsapp_alerts_queue').update({
      status: 'failed',
      error_message: 'Provedor WhatsApp não configurado ainda.',
    }).eq('id', alerta.id);

    await admin.from('audit_log').insert({
      site_key: alerta.site_key, tag: null, acao: 'Alerta WhatsApp (não enviado)',
      justificativa: `${alerta.event_type}: provedor WhatsApp não configurado ainda.`,
      operador_label: 'Sistema (whatsapp-alerts-worker)', role: 'SYSTEM',
      profile_id: alerta.recipient_profile_id,
    });
    processados++;
  }
  return processados;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    // Chamada agendada (Cron Jobs), não usuário logado -- autentica por
    // segredo compartilhado: a própria service_role key do projeto no
    // cabeçalho, configurada direto no agendamento do Cron Job.
    if (authHeader !== `Bearer ${serviceKey}`) {
      return json({ error: 'Não autorizado.' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(supabaseUrl, serviceKey);

    const enfileirados = await varredura(admin);
    const processados = await envio(admin);

    return json({ enfileirados, processados });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
