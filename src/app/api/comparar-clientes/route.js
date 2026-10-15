
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { compararClientes } from '../../../services/compararClientes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// AUTENTICACAO
// ============================================================

function autorizado(chave) {
  const segredo = process.env.AUDIT_ACCESS_KEY;

  if (!segredo || !chave) {
    return false;
  }

  const a = Buffer.from(chave);
  const b = Buffer.from(segredo);

  return a.length === b.length && timingSafeEqual(a, b);
}

// ============================================================
// NORMALIZACAO DO ID DO MONITOR
// ============================================================

function normalizarIdMonitor(valor) {
  if (typeof valor !== 'string') {
    return '';
  }

  let id = valor
    .trim()
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-');

  // Permite colar uma URL com o ID do Monitor.
  if (/^https?:\/\//i.test(id)) {
    try {
      const url = new URL(id);

      id =
        url.searchParams.get('id_monitor') ||
        url.searchParams.get('consulta_id') ||
        url.searchParams.get('id') ||
        url.pathname.split('/').filter(Boolean).pop() ||
        '';
    } catch {
      return '';
    }
  }

  id = id
    .replace(/[{}]/g, '')
    .replace(/\s+/g, '')
    .trim();

  // Aceita UUID sem hifens e adiciona a formatacao.
  if (/^[0-9a-f]{32}$/i.test(id)) {
    id = [
      id.slice(0, 8),
      id.slice(8, 12),
      id.slice(12, 16),
      id.slice(16, 20),
      id.slice(20),
    ].join('-');
  }

  return id;
}

// ============================================================
// RESPOSTA PADRONIZADA
// ============================================================

function responder(dados, status, idExecucao) {
  return Response.json(dados, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Audit-ID': idExecucao,
    },
  });
}

// ============================================================
// DIAGNOSTICO DE ERROS
// ============================================================

function diagnosticarErro(erro, duracaoTotalMs) {
  const mensagem = String(
    erro?.message || 'Erro desconhecido'
  );

  const statusEncontrado = mensagem.match(
    /\bHTTP\s+(\d{3})\b/i
  );

  const statusUpstream =
    erro?.status_upstream ??
    (statusEncontrado
      ? Number(statusEncontrado[1])
      : null);

  let etapa = erro?.etapa || 'nao_identificada';

  if (etapa === 'nao_identificada') {
    if (mensagem.includes('beneficios/consulta')) {
      etapa = 'clientes_mailing';
    } else if (mensagem.includes('consulta-cliente')) {
      etapa = 'clientes_monitor';
    } else if (mensagem.includes('consulta-relatorio')) {
      etapa = 'buscar_campanha';
    }
  }

  const origem =
    erro?.origem ||
    (etapa === 'clientes_mailing'
      ? 'mailing'
      : etapa === 'nao_identificada'
        ? null
        : 'monitor');

  const timeout =
    erro?.tipo === 'TIMEOUT' ||
    ['TimeoutError', 'AbortError'].includes(erro?.name);

  return {
    etapa,
    origem,

    tipo:
      erro?.tipo ||
      (timeout
        ? 'TIMEOUT'
        : statusUpstream
          ? 'HTTP_UPSTREAM'
          : 'ERRO_INTERNO'),

    status_upstream: statusUpstream,
    pagina: erro?.pagina ?? null,
    skip: erro?.skip ?? null,
    limite: erro?.limite ?? null,

    codigo_rede:
      erro?.codigo_rede ||
      erro?.cause?.code ||
      null,

    duracao_ms: erro?.duracao_ms ?? null,
    duracao_total_ms: duracaoTotalMs,

    resposta_resumida:
      erro?.resposta_resumida ?? null,
  };
}

// ============================================================
// LOG SEGURO DAS REQUISICOES
// ============================================================

function registrarLog(idExecucao, dados) {
  const camposPermitidos = [
    'evento',
    'etapa',
    'origem',
    'pagina',
    'skip',
    'limite',
    'status_upstream',
    'httpcode_api',
    'duracao_ms',
    'tipo',
    'codigo_rede',
    'registros_na_pagina',
    'total_informado',
    'chaves_parametros',
    'parametros_nao_reconhecidos_pelo_mailing',
  ];

  const log = {
    id_execucao: idExecucao,
  };

  for (const campo of camposPermitidos) {
    if (dados?.[campo] !== undefined) {
      log[campo] = dados[campo];
    }
  }

  if (process.env.AUDIT_DEBUG === 'true') {
    console.info(
      '[auditoria:debug]',
      JSON.stringify(log)
    );
  }
}

// ============================================================
// ROUTE PRINCIPAL
// ============================================================

export async function POST(request) {
  const idExecucao = randomUUID();
  const inicio = Date.now();

  // ----------------------------------------------------------
  // 1. VALIDAR AUTENTICACAO
  // ----------------------------------------------------------

  if (!autorizado(request.headers.get('x-audit-key'))) {
    return responder({
      sucesso: false,
      mensagem: 'Nao autorizado',
    }, 401, idExecucao);
  }

  // ----------------------------------------------------------
  // 2. LER BODY
  // ----------------------------------------------------------

  let body;

  try {
    body = await request.json();
  } catch {
    return responder({
      sucesso: false,
      mensagem: 'JSON invalido',
    }, 400, idExecucao);
  }

  // ----------------------------------------------------------
  // 3. RECUPERAR E NORMALIZAR ID
  // ----------------------------------------------------------

  const camposAceitos = [
    'id_monitor',
    'idMonitor',
    'consulta_id',
    'id',
  ];

  const campoRecebido = camposAceitos.find(
    (campo) => body?.[campo] !== undefined
  );

  const idOriginal = campoRecebido
    ? body[campoRecebido]
    : null;

  const idMonitor = normalizarIdMonitor(idOriginal);

  console.info(
    '[auditoria:validacao]',
    JSON.stringify({
      id_execucao: idExecucao,
      campo_recebido: campoRecebido || null,
      tipo_recebido: typeof idOriginal,
      tamanho_original:
        typeof idOriginal === 'string'
          ? idOriginal.length
          : null,
      tamanho_normalizado: idMonitor.length,
      id_valido: UUID_REGEX.test(idMonitor),
    })
  );

  if (!UUID_REGEX.test(idMonitor)) {
    return responder({
      sucesso: false,
      mensagem: 'ID do Monitor invalido',

      diagnostico: {
        campo_id_recebido: campoRecebido || null,

        campos_recebidos:
          body && typeof body === 'object'
            ? Object.keys(body)
            : [],

        tipo_id_recebido: typeof idOriginal,

        tamanho_original:
          typeof idOriginal === 'string'
            ? idOriginal.length
            : null,

        tamanho_normalizado: idMonitor.length,

        formato_esperado: 'UUID 8-4-4-4-12',
      },
    }, 400, idExecucao);
  }

  // ----------------------------------------------------------
  // 4. INICIAR AUDITORIA
  // ----------------------------------------------------------

  console.info(
    '[auditoria:inicio]',
    JSON.stringify({
      id_execucao: idExecucao,
      id_monitor: idMonitor,
      iniciado_em: new Date().toISOString(),
    })
  );

  try {
    const resultado = await compararClientes(
      idMonitor,
      {
        log: (dados) => registrarLog(idExecucao, dados),
      }
    );

    const duracaoMs = Date.now() - inicio;

    console.info(
      '[auditoria:sucesso]',
      JSON.stringify({
        id_execucao: idExecucao,
        duracao_ms: duracaoMs,
      })
    );

    return responder({
      ...resultado,
      id_execucao: idExecucao,
    }, 200, idExecucao);

  } catch (erro) {

    // --------------------------------------------------------
    // 5. IDENTIFICAR ORIGEM DO ERRO
    // --------------------------------------------------------

    const diagnostico = diagnosticarErro(
      erro,
      Date.now() - inicio
    );

    console.error(
      '[auditoria:erro]',
      JSON.stringify({
        id_execucao: idExecucao,
        ...diagnostico,
        mensagem: erro?.message || 'Erro desconhecido',
      })
    );

    const statusResposta =
      diagnostico.tipo === 'TIMEOUT'
        ? 504
        : diagnostico.status_upstream
          ? 502
          : 500;

    return responder({
      sucesso: false,
      id_execucao: idExecucao,

      mensagem:
        process.env.AUDIT_DEBUG === 'true'
          ? String(
              erro?.message ||
              'Falha durante a auditoria'
            )
          : 'Falha durante a auditoria',

      diagnostico: {
        etapa: diagnostico.etapa,
        origem: diagnostico.origem,
        tipo: diagnostico.tipo,

        status_upstream:
          diagnostico.status_upstream,

        pagina: diagnostico.pagina,
        skip: diagnostico.skip,
        limite: diagnostico.limite,

        codigo_rede:
          diagnostico.codigo_rede,

        duracao_ms:
          diagnostico.duracao_ms,

        duracao_total_ms:
          diagnostico.duracao_total_ms,

        ...(process.env.AUDIT_DEBUG === 'true'
          ? {
              resposta_resumida:
                diagnostico.resposta_resumida,
            }
          : {}),
      },
    }, statusResposta, idExecucao);
  }
}
