// Edge Function: admin-manage-user
// Cria e exclui contas de usuário (auth.users + profiles) em uma única
// chamada, usando a service_role key — que só existe aqui no servidor,
// nunca no navegador. Só o Admin Master logado pode chamar isso.
//
// Como publicar (sem precisar de CLI/Node instalado):
// 1. No painel do Supabase, abra "Edge Functions" no menu lateral.
// 2. Clique em "Deploy a new function", nomeie como "admin-manage-user".
// 3. Cole todo o conteúdo deste arquivo no editor e clique em "Deploy".
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já ficam disponíveis
// automaticamente dentro de toda Edge Function — não precisa configurar nada.)

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Não autenticado.' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Cliente com a identidade de quem chamou — só para descobrir quem é.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) return json({ error: 'Sessão inválida ou expirada.' }, 401);

    // Cliente com privilégio total (service_role) — nunca exposto ao navegador.
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: callerProfile } = await admin
      .from('profiles').select('role, active').eq('id', caller.id).single();
    if (!callerProfile || callerProfile.role !== 'ADMIN' || !callerProfile.active) {
      return json({ error: 'Apenas o Admin Master pode gerenciar usuários.' }, 403);
    }

    const body = await req.json();

    if (body.action === 'create') {
      const { name, email, password, role, canExport, active, sites } = body;
      if (!name || !email || !role) return json({ error: 'Preencha nome, e-mail e perfil.' }, 400);
      if (!password || password.length < 6) return json({ error: 'Informe uma senha inicial com no mínimo 6 caracteres.' }, 400);

      // Cria a conta já com a senha definida pelo Admin e o e-mail confirmado
      // de cara — a pessoa já consegue logar, sem precisar clicar em link nenhum.
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (createErr) return json({ error: createErr.message || 'Falha ao criar a conta de login (motivo desconhecido no Auth).' }, 400);

      const newId = created.user.id;
      const { error: profErr } = await admin.from('profiles').insert({
        id: newId, name, email, role, can_export: canExport, active,
      });
      if (profErr) { await admin.auth.admin.deleteUser(newId); return json({ error: profErr.message || 'Falha ao criar o perfil (motivo desconhecido no banco).' }, 400); }

      if (Array.isArray(sites) && sites.length) {
        await admin.from('profile_sites').insert(sites.map((site_key: string) => ({ profile_id: newId, site_key })));
      }
      return json({ id: newId });
    }

    if (body.action === 'delete') {
      const { id } = body;
      if (!id) return json({ error: 'ID do usuário não informado.' }, 400);
      if (id === caller.id) return json({ error: 'Você não pode excluir sua própria conta enquanto estiver logado.' }, 400);
      const { error: delErr } = await admin.auth.admin.deleteUser(id);
      if (delErr) return json({ error: delErr.message || 'Falha ao excluir a conta de login (verifique se ela não tem agendamentos/histórico vinculados).' }, 400);
      return json({ ok: true });
    }

    return json({ error: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
