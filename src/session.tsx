import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { CalendarCheck, Flag, History, LogIn, UserRound } from 'lucide-react';
import { supabase } from './lib/supabase';
import type { Branch } from './types';
import './components/session.css';

export type AppRole = 'consultor' | 'gestor' | 'admin';
export type AppUser = { matricula: string; name: string; role: AppRole };

type SessionValue = {
  user: AppUser;
  branches: Branch[];
  defaultBranches: string[];
  logout: () => void;
};

const STORAGE_KEY = 'agenda-tecnica-matricula';
const SessionContext = createContext<SessionValue | null>(null);

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [defaultBranches, setDefaultBranches] = useState<string[]>([]);
  const [matricula, setMatricula] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function resolveUser(rawMatricula: string, persist = true) {
    const clean = rawMatricula.replace(/\D/g, '').trim();
    if (!clean) return false;

    const [{ data: userRow, error: userError }, { data: branchRows, error: branchError }, { data: allBranchRows, error: allBranchError }] = await Promise.all([
      supabase.from('app_users').select('matricula,name,role').eq('matricula', clean).eq('active', true).maybeSingle(),
      supabase.from('app_user_branches').select('branch').eq('matricula', clean).order('branch'),
      supabase.from('app_branches').select('name').eq('active', true).order('name'),
    ]);

    if (userError || branchError || allBranchError || !userRow) return false;

    const allBranches = (allBranchRows || []).map((row) => ({ name: String(row.name) }));
    if (!allBranches.length) return false;

    const role = userRow.role as AppRole;
    const defaults = role === 'consultor' ? (branchRows || []).map((row) => String(row.branch)) : [];

    setUser({
      matricula: String(userRow.matricula),
      name: String(userRow.name),
      role,
    });
    setBranches(allBranches);
    setDefaultBranches(defaults);
    if (persist) localStorage.setItem(STORAGE_KEY, clean);
    return true;
  }

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      setLoading(false);
      return;
    }
    void resolveUser(saved, false).then((ok) => {
      if (!ok) localStorage.removeItem(STORAGE_KEY);
      setLoading(false);
    });
  }, []);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const ok = await resolveUser(matricula);
    if (!ok) setError('Matrícula não encontrada ou sem acesso ativo.');
    setBusy(false);
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setBranches([]);
    setDefaultBranches([]);
    setMatricula('');
    setError('');
  }

  const value = useMemo(() => user ? { user, branches, defaultBranches, logout } : null, [user, branches, defaultBranches]);

  if (loading) return <div className="session-loading">Carregando...</div>;

  if (!value) {
    return <main className="login-screen">
      <section className="login-shell">
        <aside className="login-hero">
          <img className="login-hero-brand" src="/agenda-brand.png?v=20260901-1" alt="Agenda" />
          <div className="login-hero-copy">
            <h2>Agenda Técnica</h2>
            <p>Programação de técnicos, retenção de clientes e oportunidades de pós-venda em um só lugar.</p>
            <ul>
              <li><CalendarCheck size={16}/>Agenda e rotas da equipe</li>
              <li><History size={16}/>Histórico G4 e retenção</li>
              <li><Flag size={16}/>Campanhas e Visita 150h</li>
            </ul>
          </div>
          <img className="login-hero-aria" src="/aria/aria-login.webp" alt="ArIA" />
        </aside>
        <div className="login-card">
          <div className="login-copy">
            <span className="login-kicker">Bem-vindo</span>
            <h1>Entrar na Agenda</h1>
            <p>Use sua matrícula para acessar suas filiais.</p>
          </div>
          <form onSubmit={handleLogin}>
            <label>
              <span>Matrícula</span>
              <div className="login-input">
                <UserRound size={17}/>
                <input autoFocus inputMode="numeric" value={matricula} onChange={(event) => setMatricula(event.target.value.replace(/\D/g, ''))} placeholder="Digite sua matrícula" />
              </div>
            </label>
            {error && <div className="login-error">{error}</div>}
            <button type="submit" disabled={busy || !matricula.trim()}><LogIn size={17}/>{busy ? 'Entrando...' : 'Entrar'}</button>
          </form>
          <small className="login-foot">Problemas para entrar? Fale com o administrador da sua filial.</small>
        </div>
      </section>
    </main>;
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
