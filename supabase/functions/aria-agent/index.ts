import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

// Interpreta a mensagem do usuário e devolve a intenção estruturada.
// Não grava nada: a execução acontece no app, sempre com confirmação.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const str = (description: string) => ({ type: 'string', description });

const TOOLS = [
  { name: 'trocar_filial_tecnico', description: 'Mudar a filial de um técnico.', parameters: { tecnico: str('Nome do técnico'), filial: str('Filial de destino, se informada') } },
  { name: 'agendar_atendimento', description: 'Criar um agendamento na agenda (inclui Visita 150h e Campanha de campo).', parameters: { tipo: str('Motivo: "Visita 150h", "Campanha de campo", "Revisão PMP", "Garantia", "Diagnóstico", "Oficina", "Entrega Técnica" ou outro motivo citado'), pin: str('Série/PIN da máquina, se informado'), cliente: str('Nome do cliente, se informado'), tecnico: str('Nome do técnico, se informado'), data: str('Data no formato AAAA-MM-DD, se informada') } },
  { name: 'remarcar_atendimento', description: 'Mudar a data e/ou o técnico de um agendamento existente.', parameters: { tecnico: str('Técnico do agendamento atual'), cliente_ou_pin: str('Cliente ou PIN do agendamento'), data_atual: str('Data atual AAAA-MM-DD, se informada'), nova_data: str('Nova data AAAA-MM-DD, se informada'), novo_tecnico: str('Novo técnico, se informado') } },
  { name: 'concluir_atendimento', description: 'Marcar um agendamento como concluído/executado.', parameters: { tecnico: str('Técnico'), cliente_ou_pin: str('Cliente ou PIN'), data: str('Data AAAA-MM-DD') } },
  { name: 'excluir_atendimento', description: 'Cancelar/excluir um agendamento.', parameters: { tecnico: str('Técnico'), cliente_ou_pin: str('Cliente ou PIN'), data: str('Data AAAA-MM-DD') } },
  { name: 'adicionar_tecnico', description: 'Cadastrar um novo técnico.', parameters: { nome: str('Nome do técnico'), filial: str('Filial') } },
  { name: 'desativar_tecnico', description: 'Desativar/remover um técnico da agenda.', parameters: { tecnico: str('Nome do técnico') } },
  { name: 'criar_followup', description: 'Abrir um follow-up (tratativa comercial) para um cliente.', parameters: { cliente: str('Cliente'), observacao: str('Observação'), data_retorno: str('Data do próximo contato AAAA-MM-DD') } },
  { name: 'informar_cidade_maquina', description: 'Registrar a cidade onde uma máquina de Visita 150h ou campanha está.', parameters: { pin: str('PIN/série'), cidade: str('Cidade') } },
  { name: 'oportunidades_rota', description: 'O que um técnico pode aproveitar na rota (campanhas/150h pendentes nas cidades da agenda dele).', parameters: { tecnico: str('Nome do técnico') } },
  { name: 'pendencias_filial', description: 'Resumo de pendências de Visita 150h e campanhas.', parameters: { filial: str('Filial, se citada') } },
  { name: 'consultar_agenda', description: 'Ver os próximos atendimentos de um técnico.', parameters: { tecnico: str('Nome do técnico') } },
  { name: 'resumo_cliente', description: 'Resumo/histórico de um cliente ou máquina.', parameters: { cliente: str('Cliente ou PIN') } },
  { name: 'clientes_inativos', description: 'Clientes sem atendimento há muito tempo numa cidade.', parameters: { cidade: str('Cidade'), meses: str('Meses sem atendimento') } },
  { name: 'followups_hoje', description: 'Quem ligar hoje / follow-ups vencidos.', parameters: {} },
  { name: 'navegar', description: 'Abrir uma tela do app.', parameters: { tela: str('agenda, retencao, mapa, followup, dashboard, visita150h, campanhas, usuarios') } },
].map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: { type: 'object', properties: tool.parameters } } }));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const groqKey = Deno.env.get('GROQ_API_KEY');
    if (!groqKey) return json({ ok: false, reason: 'no_llm' });
    const { message, history = [], context = {} } = await req.json();
    if (!message) return json({ ok: false, reason: 'empty' });

    const system = `Você é a ArIA, assistente operacional da agenda de técnicos de pós-venda de máquinas pesadas (Volvo CE, SDLG) do Grupo Tracbel.
Hoje é ${context.today || ''}. Usuário: ${context.user?.name || ''} (${context.user?.role || ''}).
Técnicos ativos: ${(context.technicians || []).map((t: any) => `${t.name} (${t.branch})`).join('; ')}.
Filiais ativas: ${(context.branches || []).join(', ')}.
Regras:
- Se o pedido corresponder a uma ação ou consulta, chame UMA ferramenta com os dados que o usuário deu. Não invente dados que ele não falou: deixe o campo vazio e o app vai perguntar.
- Converta datas relativas (amanhã, sexta, dia 15) para AAAA-MM-DD usando a data de hoje.
- Use os nomes de técnicos e filiais exatamente como na lista acima quando houver correspondência.
- Se for conversa, dúvida geral ou algo sem ferramenta, responda em português, curto e prático, sem inventar números.`;

    const messages = [
      { role: 'system', content: system },
      ...history.slice(-6).map((m: any) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.text || '').slice(0, 800) })),
      { role: 'user', content: String(message).slice(0, 1000) },
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({ model: Deno.env.get('GROQ_MODEL') || 'llama-3.3-70b-versatile', messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.1, max_completion_tokens: 500 }),
    });
    if (!response.ok) return json({ ok: false, reason: `llm_http_${response.status}` });
    const data = await response.json();
    const choice = data.choices?.[0]?.message;
    const call = choice?.tool_calls?.[0];
    if (call) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
      return json({ ok: true, intent: call.function.name, args });
    }
    return json({ ok: true, reply: String(choice?.content || '').trim() });
  } catch (error) {
    console.error('aria_agent_failed', error);
    return json({ ok: false, reason: 'error' });
  }
});
