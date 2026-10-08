#!/usr/bin/env python3
"""Troca a base G4 (public.g4_ordens_servico) a partir do CSV exportado do G4.

Uso (projeto principal ydziukxbglyuknamcokd, token em $SUPABASE_ACCESS_TOKEN):
  python3 -I scripts/g4_import.py prepare base_g4.csv     # só lê o CSV e mostra o relatório
  python3 -I scripts/g4_import.py stage   base_g4.csv     # carrega em g4_ordens_servico_stage (não toca a tabela do app)
  python3 -I scripts/g4_import.py check                   # compara stage x atual
  python3 -I scripts/g4_import.py keep-missing            # copia para a stage as OS atuais ausentes do CSV
  python3 -I scripts/g4_import.py swap                    # backup + troca + refresh, numa transação
"""
import csv
import json
import os
import re
import sys
import unicodedata
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta

PROJECT = 'ydziukxbglyuknamcokd'
STAGE = 'g4_ordens_servico_stage'
BACKUP = 'g4_ordens_servico_bkp_20261008'

COLUMNS = [
    ('codigo_os_sap', 'CÓDIGO OS SAP', 'int'),
    ('codigo_os_g4', 'CÓDIGO OS G4', 'text'),
    ('razao_social', 'RAZÃO SOCIAL', 'text'),
    ('numero_serie', 'NÚMERO SÉRIE', 'text'),
    ('equipamento_parado', 'EQUIPAMENTO PARADO', 'text'),
    ('cidade', 'CIDADE', 'text'),
    ('equipe', 'EQUIPE', 'text'),
    ('tipo_de_os', 'TIPO DE OS', 'text'),
    ('tipo_de_operacao', 'TIPO DE OPERAÇÃO', 'text'),
    ('status', 'STATUS', 'text'),
    ('data_primeiro_contato', 'DATA PRIMEIRO CONTATO', 'ts'),
    ('data_aguardando_aprovacao', 'DATA AGUARDANDO APROVAÇÃO', 'ts'),
    ('data_orcamento_aprovado', 'DATA ORÇAMENTO APROVADO', 'ts'),
    ('data_abertura', 'DATA ABERTURA', 'ts'),
    ('data_inicio', 'DATA INÍCIO', 'ts'),
    ('data_fechamento', 'DATA FECHAMENTO', 'ts'),
    ('tempo_aprovacao_da_os', 'TEMPO APROVAÇÃO DA OS', 'num'),
    ('tempo_de_atendimento', 'TEMPO DE ATENDIMENTO', 'num'),
    ('tempo_os_aberta', 'TEMPO OS ABERTA', 'num'),
    ('tempo_aprovacao_atendimento', 'TEMPO APROVAÇÃO -> ATENDIMENTO', 'num'),
    ('descricao', 'DESCRICAO', 'text'),
    ('filial', 'FILIAL', 'branch'),
    ('endereco', 'ENDERECO', 'text'),
    ('bairro', 'BAIRRO', 'text'),
    ('cidade_contato', 'CIDADE_1', 'text'),
    ('estado', 'ESTADO', 'text'),
    ('nome_contato', 'NOME CONTATO', 'text'),
    ('email_contato', 'E-MAIL CONTATO', 'text'),
    ('telefones', 'TELEFONES', 'text'),
]
DB_COLS = ['id'] + [c[0] for c in COLUMNS] + ['ano_origem']
MIN_TS, MAX_TS = datetime(2000, 1, 1), datetime(2100, 1, 1)
stats = Counter()


def text(v):
    v = (v or '').replace('\x00', '').strip()
    return v or None


def branch(v):
    v = text(v)
    if not v:
        return None
    v = unicodedata.normalize('NFKD', v).encode('ascii', 'ignore').decode()
    return re.sub(r'\s+', ' ', v).upper()


def num(v):
    v = text(v)
    if v and re.fullmatch(r'-?\d+,\d+', v):
        return v.replace(',', '.')
    return v


def ts(v, col):
    v = text(v)
    if not v:
        return None
    out = None
    m = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?', v)
    if m:
        d, mo, y, h, mi, s = m.groups()
        try:
            out = datetime(int(y), int(mo), int(d), int(h or 0), int(mi or 0), int(s or 0))
        except ValueError:
            out = None
    elif re.fullmatch(r'\d+(?:[.,]\d+)?', v):
        stats[f'{col}: serial do Excel convertido'] += 1
        out = datetime(1899, 12, 30) + timedelta(days=float(v.replace(',', '.')))
        out = out.replace(microsecond=0)
    if out is None or not (MIN_TS <= out < MAX_TS):
        stats[f'{col}: data inválida/fora de 2000-2099 -> vazia'] += 1
        return None
    return out.strftime('%Y-%m-%d %H:%M:%S')


def convert(row, ix):
    rec = {}
    for db, src, kind in COLUMNS:
        raw = row[ix[src]] if src in ix else ''
        if kind == 'ts':
            rec[db] = ts(raw, db)
        elif kind == 'num':
            rec[db] = num(raw)
        elif kind == 'branch':
            rec[db] = branch(raw)
        elif kind == 'int':
            t = text(raw)
            rec[db] = int(t) if t and t.isdigit() else None
        else:
            rec[db] = text(raw)
    return rec


def activity(rec):
    dates = [rec[k] for k in ('data_fechamento', 'data_inicio', 'data_abertura', 'data_primeiro_contato') if rec[k]]
    filled = sum(1 for v in rec.values() if v is not None)
    return (max(dates) if dates else '', filled)


def prepare(path):
    with open(path, newline='', encoding='utf-8-sig') as h:
        reader = csv.reader(h, delimiter=';')
        header = [c.strip() for c in next(reader)]
        ix = {c: i for i, c in enumerate(header)}
        missing = [src for _, src, _ in COLUMNS if src not in ix]
        if missing:
            sys.exit(f'colunas ausentes no CSV: {missing}')
        best = {}
        order = []
        for n, row in enumerate(reader, 2):
            if len(row) != len(header):
                sys.exit(f'linha {n}: {len(row)} colunas, esperado {len(header)}')
            stats['linhas lidas'] += 1
            rec = convert(row, ix)
            if rec['codigo_os_sap'] is None or not rec['codigo_os_g4']:
                stats['descartada: sem código SAP/G4'] += 1
                continue
            if not rec['data_abertura']:
                stats['descartada: sem data de abertura'] += 1
                continue
            key = rec['codigo_os_g4']
            if key in best:
                stats['código G4 repetido (mantida a mais recente)'] += 1
                if activity(rec) >= activity(best[key]):
                    best[key] = rec
            else:
                best[key] = rec
                order.append(key)
    recs = []
    for i, key in enumerate(order, 1):
        rec = best[key]
        rec['id'] = i
        rec['ano_origem'] = int(rec['data_abertura'][:4])
        recs.append(rec)
    return recs


def report(recs):
    print('== Relatório (somente leitura) ==')
    for k, v in sorted(stats.items()):
        print(f'  {k}: {v}')
    print(f'  linhas a carregar: {len(recs)}')
    print('  período de abertura:', min(r['data_abertura'] for r in recs), 'a', max(r['data_abertura'] for r in recs))
    print('  por filial:')
    for k, v in sorted(Counter(r['filial'] for r in recs).items(), key=lambda x: str(x[0])):
        print(f'    {k}: {v}')


def api(query):
    token = os.environ.get('SUPABASE_ACCESS_TOKEN')
    if not token:
        sys.exit('defina SUPABASE_ACCESS_TOKEN')
    req = urllib.request.Request(
        f'https://api.supabase.com/v1/projects/{PROJECT}/database/query',
        data=json.dumps({'query': query}).encode(),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read() or b'[]')
    except urllib.error.HTTPError as e:
        sys.exit(f'erro da API ({e.code}): {e.read().decode()[:2000]}')


def lit(v):
    if v is None:
        return 'null'
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def stage(path):
    recs = prepare(path)
    report(recs)
    api(f'drop table if exists public.{STAGE}; '
        f'create table public.{STAGE} (like public.g4_ordens_servico including defaults including constraints including indexes); '
        f'alter table public.{STAGE} enable row level security;')
    cols = ', '.join(DB_COLS)
    batch = 1500
    for i in range(0, len(recs), batch):
        values = ',\n'.join('(' + ', '.join(lit(r[c]) for c in DB_COLS) + ')' for r in recs[i:i + batch])
        api(f'insert into public.{STAGE} ({cols}) values\n{values};')
        print(f'  stage: {min(i + batch, len(recs))}/{len(recs)}')
    check()


def check():
    rows = api(f"""
      select 'atual' as tabela, count(*) as linhas, count(distinct filial) as filiais, min(data_abertura)::text as de, max(data_abertura)::text as ate from public.g4_ordens_servico
      union all
      select 'nova (stage)', count(*), count(distinct filial), min(data_abertura)::text, max(data_abertura)::text from public.{STAGE};""")
    for r in rows:
        print(f"  {r['tabela']}: {r['linhas']} linhas, {r['filiais']} filiais, {r['de']} a {r['ate']}")
    lost = api(f"""select count(*) as n from public.g4_ordens_servico a
                   where not exists (select 1 from public.{STAGE} s where s.codigo_os_g4 = a.codigo_os_g4);""")
    print(f"  OS que existem hoje e não estão no arquivo novo: {lost[0]['n']}")


def keep_missing():
    cols = [c for c in DB_COLS if c != 'id'] + ['importado_em']
    col_list = ', '.join(cols)
    sel = ', '.join(f'a.{c}' for c in cols)
    res = api(f"""
      with missing as (
        select a.* from public.g4_ordens_servico a
        where not exists (select 1 from public.{STAGE} s where s.codigo_os_g4 = a.codigo_os_g4)
      ), ins as (
        insert into public.{STAGE} (id, {col_list})
        select (select coalesce(max(id), 0) from public.{STAGE}) + row_number() over (order by a.id), {sel}
        from missing a
        returning 1
      )
      select count(*) as n from ins;""")
    print(f"  OS mantidas da base atual: {res[0]['n']}")
    check()


def swap():
    n = api(f'select count(*) as n from public.{STAGE};')[0]['n']
    if n < 1000:
        sys.exit(f'stage com {n} linhas; abortado')
    api(f"""
      begin;
      create table public.{BACKUP} as select * from public.g4_ordens_servico;
      truncate table public.g4_ordens_servico;
      insert into public.g4_ordens_servico select * from public.{STAGE};
      select private.refresh_g4_app_cache();
      select private.refresh_g4_client_city_summary();
      select private.refresh_g4_client_location_summary();
      select private.refresh_inspection_150h();
      commit;""")
    print('  troca concluída. backup em', BACKUP)
    check()


if __name__ == '__main__':
    if len(sys.argv) < 2 or sys.argv[1] not in ('prepare', 'stage', 'check', 'keep-missing', 'swap'):
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == 'prepare':
        report(prepare(sys.argv[2]))
    elif cmd == 'stage':
        stage(sys.argv[2])
    elif cmd == 'check':
        check()
    elif cmd == 'keep-missing':
        keep_missing()
    else:
        swap()
