# Controle de Agenda

Aplicação limpa para agenda técnica, retenção, equipamentos e follow-up, usando o histórico G4 como fonte de contexto.

## Princípio

A agenda é o centro do produto. O G4 ajuda a preencher contexto e identificar retenção; ele não é despejado inteiro na interface. A camada de IA é um copiloto e pode retornar `NO_INSIGHT`.

## Stack

- React + Vite + TypeScript
- Supabase
- Vercel
- Gemini opcional via Edge Function `agenda-insights`

## Tutorial da ArIA

O tutorial usa as quatro expressões da ArIA de forma aleatória e inclui passos guiados em que a interface destaca o controle correto e aguarda o clique do usuário antes de avançar.

## Desenvolvimento

```bash
npm install
npm run dev
```

As variáveis públicas estão documentadas em `.env.example`.
