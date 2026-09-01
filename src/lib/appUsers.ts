import type { AppRole } from '../session';

export type CanonicalAppUser = {
  matricula: string;
  name: string;
  role: AppRole;
  branches: 'all' | string[];
};

export const CANONICAL_APP_USERS: CanonicalAppUser[] = [
  { matricula: '19124', name: 'Alisson Mafra', role: 'admin', branches: 'all' },
  { matricula: '19103', name: 'Hamilton Matias', role: 'gestor', branches: 'all' },
  { matricula: '44033', name: 'Delmiro Neto', role: 'gestor', branches: 'all' },
  { matricula: '19115', name: 'Vinicius Furtado', role: 'consultor', branches: ['MARITUBA', 'MIRITITUBA'] },
  { matricula: '4629', name: 'Tiago Gomes', role: 'consultor', branches: ['MARABA', 'MANAUS'] },
  { matricula: '4846', name: 'Lana Freitas', role: 'consultor', branches: ['SAO LUIS'] },
  { matricula: '44031', name: 'Alex Barbosa', role: 'consultor', branches: ['BALSAS', 'IMPERATRIZ'] },
  { matricula: '4595', name: 'Thauana Matos', role: 'consultor', branches: ['ITAITINGA', 'TERESINA'] },
];

export function canonicalUser(matricula: string) {
  return CANONICAL_APP_USERS.find((item) => item.matricula === matricula) || null;
}
