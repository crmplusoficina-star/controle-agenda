import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { LogIn } from 'lucide-react';
import { supabase } from './lib/supabase';
import type { Branch } from './types';
import './components/session.css';

export type AppRole = 'consultor' | 'gestor' | 'admin';
export type AppUser = { matricula: string; name: string; role: AppRole };

type SessionValue = {
  user: AppUser;
  branches: Branch[];
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
  const [matricula, setMatricula] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function resolveUser(rawMatricula: string, persist = true) {
    const clean = rawMatricula.replace(/\D/g, '').trim();
    if (!clean) return false;

    const [{ data: userRow, error: userError }, { data: branchRows, error: branchError }] = await Promise.all([
      supabase.from('app_users').select('matricula,name,role').eq('matricula', clean).eq('active', true).maybeSingle(),
      supabase.from('app_user_branches').select('branch').eq('matricula', clean).order('branch'),
    ]);

    if (userError || branchError || !userRow) return false;

    const allowed = (branchRows || []).map((row) => ({ name: String(row.branch) }));
    if (!allowed.length) return false;

    setUser({ matricula: String(userRow.matricula), name: String(userRow.name), role: userRow.role as AppRole });
    setBranches(allowed);
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
    setMatricula('');
    setError('');
  }

  const value = useMemo(() => user ? { user, branches, logout } : null, [user, branches]);

  if (loading) return <div className="session-loading">Carregando...</div>;

  if (!value) {
    return <main className="login-screen">
      <section className="login-card">
        <div className="login-brand-image-wrap">
          <img className="login-brand-image" src="/agenda-brand.svg?v=20260831-3" alt="Agenda" />
        </div>
        <div className="login-copy">
          <h1>Agenda Técnica</h1>
          <p>Retenção de atendimentos</p>
        </div>
        <form onSubmit={handleLogin}>
          <label>
            <span>Matrícula</span>
            <input autoFocus inputMode="numeric" value={matricula} onChange={(event) => setMatricula(event.target.value.replace(/\D/g, ''))} placeholder="Digite sua matrícula" />
          </label>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={busy || !matricula.trim()}><LogIn size={17}/>{busy ? 'Entrando...' : 'Entrar'}</button>
        </form>
      </section>
    </main>;
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
