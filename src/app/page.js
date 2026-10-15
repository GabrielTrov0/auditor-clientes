'use client';
import { useState } from 'react';

export default function Home() {
  const [id, setId] = useState('');
  const [chave, setChave] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState('');

  async function consultar(evento) {
    evento.preventDefault();
    setErro(''); setResultado(null); setCarregando(true);
    try {
      const resposta = await fetch('/api/comparar-clientes', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'x-audit-key': chave },
        body: JSON.stringify({ id_monitor: id.trim() }),
      });
      const dados = await resposta.json();
      if (!resposta.ok) throw new Error(dados.mensagem || `HTTP ${resposta.status}`);
      setResultado(dados);
    } catch (e) { setErro(e.message); }
    finally { setCarregando(false); }
  }

  function baixarJson() {
    if (!resultado) return;
    const blob = new Blob([JSON.stringify(resultado, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `auditoria-${resultado.campanha.id}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  return <main>
    <header><span className="tag">MONITOR × MAILING</span><h1>Auditoria de clientes</h1><p>Compare os CPFs da campanha com os CPFs elegíveis na base atual, usando os filtros originais.</p></header>
    <form onSubmit={consultar}>
      <label>ID do Monitor<input required value={id} onChange={e => setId(e.target.value)} placeholder="UUID da campanha" /></label>
      <label>Chave de auditoria<input required type="password" autoComplete="off" value={chave} onChange={e => setChave(e.target.value)} placeholder="AUDIT_ACCESS_KEY" /></label>
      <button disabled={carregando}>{carregando ? 'Consultando as duas APIs...' : 'Comparar clientes'}</button>
    </form>
    {erro && <p className="erro" role="alert">{erro}</p>}
    {resultado && <section className="resultado">
      <h2>{resultado.campanha.nome}</h2><p>Campanha: {resultado.campanha.id}</p>
      <div className="cards">
        {[
          ['Registros no Monitor', resultado.resumo.registros_monitor],
          ['Registros no Mailing', resultado.resumo.registros_mailing],
          ['CPFs em ambos', resultado.resumo.cpfs_em_ambos],
          ['Somente no Mailing', resultado.resumo.somente_no_mailing],
          ['Somente no Monitor', resultado.resumo.somente_no_monitor],
          ['Erros registrados no Monitor', resultado.resumo.total_status_erro_monitor],
        ].map(([nome, valor]) => <div className="card" key={nome}><small>{nome}</small><strong>{valor.toLocaleString('pt-BR')}</strong></div>)}
      </div>
      <button type="button" className="secondary" onClick={baixarJson}>Baixar JSON das diferenças</button>
      <p className="aviso">Os registros exclusivos estão no arquivo JSON em <code>divergencias.somente_no_mailing</code> e <code>divergencias.somente_no_monitor</code>. O resultado não confirma, por si só, falha de importação.</p>
    </section>}
  </main>;
}
