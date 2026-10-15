// Auditoria somente-leitura.
// Os filtros sao obtidos da campanha no Monitor.

const MONITOR_PAGE_SIZE = 500;
const MAILING_PAGE_SIZE = 500;
const MAX_PAGES = 10000;
const TIMEOUT_MS = 120000;

// Chaves reconhecidas no MontarFiltrosConsultaBeneficios.js
// do repositorio api_mailing.
const FILTROS_MAILING_RECONHECIDOS = new Set([
  'uf_cliente',
  'cidade_cliente',
  'codigo_banco_recebimento',
  'tipo_emprestimo',
  'consignavel',
  'idade_minima',
  'idade_maxima',
  'parcela_minima',
  'parcela_maxima',
  'taxa_minima',
  'taxa_maxima',
  'filtro_debito',
  'especie_codigo',
  'especie_bloqueada',
  'possui_representante',
  'possui_cartao',
]);

// ============================================================
// CONFIGURACAO
// ============================================================

function config(nome) {
  const valor = process.env[nome]?.trim();

  if (!valor) {
    throw new Error(
      `Falta a variavel ${nome} no .env.local`
    );
  }

  return valor;
}

function tokenConfigurado(nome) {
  // Aceita o token puro ou colado com prefixo Bearer/JWT.
  // Evita gerar "Bearer Bearer TOKEN".
  const token = config(nome)
    .replace(/^(Bearer|JWT)\s+/i, '')
    .trim();

  if (!token || /\s/.test(token)) {
    throw new Error(
      `${nome} possui formato invalido no .env.local`
    );
  }

  return token;
}

// ============================================================
// LOGS
// ============================================================

function emitirLog(log, dados) {
  if (typeof log !== 'function') return;

  try {
    log(dados);
  } catch {
    // Uma falha no logger nao pode interromper a auditoria.
  }
}

// ============================================================
// MONTAGEM DA URL
// ============================================================

function urlGet(base, caminho, parametros) {
  const url = new URL(
    `${base.replace(/\/+$/, '')}/${caminho.replace(/^\/+/, '')}`
  );

  for (const [chave, valor] of Object.entries(parametros)) {
    if (valor == null || valor === '') continue;

    if (Array.isArray(valor)) {
      url.searchParams.set(chave, valor.join(','));
    } else if (
      ['string', 'number', 'boolean'].includes(typeof valor)
    ) {
      url.searchParams.set(chave, String(valor));
    } else {
      throw new Error(
        `Filtro ${chave} possui formato nao suportado`
      );
    }
  }

  return url;
}

// ============================================================
// TRATAMENTO SEGURO DA RESPOSTA
// ============================================================

function mensagemResposta(json) {
  const texto = json && typeof json === 'object'
    ? (json.response ?? json.message ?? '')
    : '';

  if (typeof texto !== 'string') return null;

  return texto
    .slice(0, 180)
    .replace(/\b\d{11}\b/g, '[CPF omitido]')
    .replace(
      /\b(Bearer|JWT)\s+\S+/gi,
      '[token omitido]'
    )
    .replace(/[\r\n\t]+/g, ' ') || null;
}

function falhar(mensagem, detalhes, log) {
  const erro = Object.assign(
    new Error(mensagem),
    detalhes
  );

  emitirLog(log, {
    evento: 'requisicao_erro',
    ...detalhes,
  });

  throw erro;
}

// ============================================================
// REQUISICAO HTTP COM DIAGNOSTICO
// ============================================================

async function getJson(
  base,
  caminho,
  parametros,
  token,
  contexto,
  log
) {
  const inicio = Date.now();

  const detalhes = {
    etapa: contexto.etapa,
    origem: contexto.origem,
    pagina: contexto.pagina ?? null,
    skip: contexto.skip ?? null,
    limite: contexto.limite ?? null,
  };

  let url;

  try {
    url = urlGet(base, caminho, parametros);
  } catch (erro) {
    falhar(
      `${caminho}: ${erro.message}`,
      {
        ...detalhes,
        tipo: 'PARAMETROS_INVALIDOS',
        duracao_ms: Date.now() - inicio,
      },
      log
    );
  }

  emitirLog(log, {
    evento: 'requisicao_inicio',
    ...detalhes,
    chaves_parametros: [
      ...url.searchParams.keys(),
    ],
  });

  let resposta;

  try {
    resposta = await fetch(url, {
      method: 'GET',

      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },

      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (erro) {
    const codigo =
      erro?.cause?.code ||
      erro?.code ||
      null;

    const timeout =
      ['TimeoutError', 'AbortError'].includes(erro?.name) ||
      ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(codigo);

    falhar(
      `${caminho}: ${
        timeout ? 'timeout' : 'falha de conexao'
      }${codigo ? ` (${codigo})` : ''}`,
      {
        ...detalhes,
        tipo: timeout ? 'TIMEOUT' : 'REDE',
        codigo_rede: codigo,
        duracao_ms: Date.now() - inicio,
      },
      log
    );
  }

  // ----------------------------------------------------------
  // LER RESPOSTA JSON
  // ----------------------------------------------------------

  let json;

  try {
    json = await resposta.json();
  } catch (erro) {
    const timeout = [
      'TimeoutError',
      'AbortError',
    ].includes(erro?.name);

    falhar(
      `${caminho}: ${
        timeout
          ? 'timeout ao ler resposta'
          : `resposta nao e JSON (HTTP ${resposta.status})`
      }`,
      {
        ...detalhes,

        tipo: timeout
          ? 'TIMEOUT'
          : resposta.ok
            ? 'JSON_INVALIDO'
            : 'HTTP_UPSTREAM',

        status_upstream: resposta.status,
        duracao_ms: Date.now() - inicio,
      },
      log
    );
  }

  const codigoApi =
    json?.httpcode != null
      ? Number(json.httpcode)
      : null;

  // ----------------------------------------------------------
  // IDENTIFICAR FIM DE PAGINACAO
  // ----------------------------------------------------------

  const semResultados =
    resposta.status === 404 &&
    codigoApi === 404 &&
    (
      (
        contexto.etapa === 'clientes_mailing' &&
        Array.isArray(json.beneficios) &&
        json.beneficios.length === 0
      ) ||
      (
        contexto.etapa === 'clientes_monitor' &&
        json.consulta === false
      ) ||
      (
        contexto.etapa === 'total_beneficios_mailing' &&
        Number(json.beneficios ?? json.total ?? 0) === 0
      )
    );

  if (semResultados) {
    emitirLog(log, {
      evento: 'requisicao_fim',
      ...detalhes,
      status_upstream: 404,
      httpcode_api: 404,
      duracao_ms: Date.now() - inicio,
      sem_resultados: true,
    });

    return {
      ...json,
      semResultados: true,
    };
  }

  // ----------------------------------------------------------
  // IDENTIFICAR ERROS DA API
  // ----------------------------------------------------------

  if (
    !resposta.ok ||
    (codigoApi !== null && codigoApi !== 200)
  ) {
    const status = !resposta.ok
      ? resposta.status
      : codigoApi;

    const dica =
      status === 401 &&
      contexto.origem === 'mailing'
        ? ' - confira TOKEN_MAILING e permissao root'
        : '';

    falhar(
      `${caminho}: HTTP ${status}${dica}`,
      {
        ...detalhes,

        tipo:
          status === 401
            ? 'AUTENTICACAO_UPSTREAM'
            : 'HTTP_UPSTREAM',

        status_upstream: status,
        httpcode_api: codigoApi,

        duracao_ms: Date.now() - inicio,
        resposta_resumida: mensagemResposta(json),
      },
      log
    );
  }

  // ----------------------------------------------------------
  // REQUISICAO CONCLUIDA
  // ----------------------------------------------------------

  emitirLog(log, {
    evento: 'requisicao_fim',
    ...detalhes,

    status_upstream: resposta.status,
    httpcode_api: codigoApi,
    duracao_ms: Date.now() - inicio,

    registros_na_pagina: Array.isArray(json.dados)
      ? json.dados.length
      : Array.isArray(json.beneficios)
        ? json.beneficios.length
        : null,

    total_informado: json.total ?? null,
  });

  return json;
}

// ============================================================
// NORMALIZACAO CPF
// ============================================================

function normalizarCpf(valor) {
  if (valor === null || valor === undefined) {
    return null;
  }

  const cpf = String(valor).replace(/\D/g, '');

  return cpf.length > 0 && cpf.length <= 11
    ? cpf.padStart(11, '0')
    : null;
}

function inteiroNaoNegativo(valor, origem) {
  const numero = Number(valor);

  if (!Number.isSafeInteger(numero) || numero < 0) {
    throw new Error(
      `Total invalido recebido de ${origem}`
    );
  }

  return numero;
}

// ============================================================
// BUSCAR CAMPANHA NO MONITOR
// ============================================================

async function buscarCampanha(id, monitor, log) {
  const resposta = await getJson(
    monitor.url,
    'consulta-relatorio/consulta',
    {
      id_empresa: monitor.empresa,
      id,
      ativo: true,
      integracao_categoria: 'campanha',
      integracao_subcategoria: 'ligacao',
      take: 1,

      // Nao usar campanhas_recentes_nao_agrupadas.
      // Ele aplica distinct e logica adicional.
      // Aqui consultamos a campanha diretamente pelo ID.
    },
    monitor.token,
    {
      etapa: 'buscar_campanha',
      origem: 'monitor',
    },
    log
  );

  const campanha = (resposta.dados || [])
    .find((item) => item.id === id);

  if (!campanha) {
    throw new Error(
      'Campanha nao encontrada com os filtros informados no Monitor'
    );
  }

  if (campanha.origem !== 'base') {
    throw new Error(
      `Campanha de origem ${campanha.origem}: esta auditoria atende origem base`
    );
  }

  const filtros = campanha.query_consulta_base;

  if (
    !filtros ||
    typeof filtros !== 'object' ||
    Array.isArray(filtros) ||
    !Object.keys(filtros).length
  ) {
    throw new Error(
      'Campanha nao possui query_consulta_base valida'
    );
  }

  return campanha;
}

// ============================================================
// BUSCAR CLIENTES DO MONITOR
// ============================================================

async function buscarClientesMonitor(id, monitor, log) {
  const registros = [];
  let total = null;

  for (let pagina = 0; pagina < MAX_PAGES; pagina++) {
    const skip = pagina * MONITOR_PAGE_SIZE;

    const resposta = await getJson(
      monitor.url,
      'consulta-cliente',
      {
        consulta_id: id,
        skip,
        take: MONITOR_PAGE_SIZE,
      },
      monitor.token,
      {
        etapa: 'clientes_monitor',
        origem: 'monitor',
        pagina: pagina + 1,
        skip,
        limite: MONITOR_PAGE_SIZE,
      },
      log
    );

    if (resposta.semResultados) {
      if (pagina === 0) {
        return {
          total: 0,
          registros: [],
        };
      }

      throw new Error(
        'Monitor retornou 404 antes de completar o total: auditoria interrompida'
      );
    }

    if (!Array.isArray(resposta.dados)) {
      throw new Error(
        'Monitor nao retornou dados[]'
      );
    }

    const informado = inteiroNaoNegativo(
      resposta.total,
      'Monitor'
    );

    if (total === null) {
      total = informado;
    }

    if (informado !== total) {
      throw new Error(
        'Total do Monitor mudou durante a consulta'
      );
    }

    if (
      resposta.dados.length === 0 &&
      registros.length < total
    ) {
      throw new Error(
        'Paginacao do Monitor terminou antes do total esperado'
      );
    }

    registros.push(...resposta.dados);

    if (registros.length > total) {
      throw new Error(
        'Monitor retornou mais linhas que o total informado'
      );
    }

    if (registros.length === total) {
      return {
        total,
        registros,
      };
    }
  }

  throw new Error(
    'Limite de paginas do Monitor atingido'
  );
}

// ============================================================
// BUSCAR TOTAL DE BENEFICIOS DO MAILING
// ============================================================

async function buscarTotalBeneficiosMailing(
  filtros,
  mailing,
  log
) {
  const params = { ...filtros };

  // A quantidade deve usar os mesmos filtros funcionais da campanha.
  // skip nao faz parte da regra de negocio.
  delete params.skip;

  // Na SolicitacaoLeads, "limite" limita o total final da solicitacao,
  // mas nao faz parte da contagem do total disponivel.
  const limiteRecebido = Number.parseInt(
    params.limite,
    10
  );

  delete params.limite;

  const resposta = await getJson(
    mailing.url,
    'beneficios/quantidade/consulta',
    params,
    mailing.token,
    {
      etapa: 'total_beneficios_mailing',
      origem: 'mailing',
    },
    log
  );

  if (resposta.semResultados) {
    return {
      total_disponivel: 0,
      total_beneficios: 0,

      limite_campanha:
        Number.isSafeInteger(limiteRecebido) &&
        limiteRecebido > 0
          ? Math.min(
              limiteRecebido,
              1000000
            )
          : 1000000,
    };
  }

  const totalDisponivel = inteiroNaoNegativo(
    resposta.beneficios ??
      resposta.total ??
      0,
    'Mailing - quantidade de beneficios'
  );

  // Replica a regra atual de LimiteSolicitacaoLeads.js:
  // limite padrao/maximo = 1.000.000.
  const limiteCampanha =
    Number.isSafeInteger(limiteRecebido) &&
    limiteRecebido > 0
      ? Math.min(
          limiteRecebido,
          1000000
        )
      : 1000000;

  return {
    total_disponivel:
      totalDisponivel,

    // Este e o valor equivalente ao total_beneficios salvo
    // pela SolicitacaoLeads para os filtros da campanha.
    total_beneficios:
      Math.min(
        totalDisponivel,
        limiteCampanha
      ),

    limite_campanha:
      limiteCampanha,
  };
}

// ============================================================
// BUSCAR CLIENTES DO MAILING
// ============================================================

async function buscarClientesMailing(
  filtros,
  mailing,
  log
) {
  const registros = [];

  // Preserva todos os filtros originais da campanha.
  const params = { ...filtros };

  // A paginacao precisa ser controlada pelo auditor.
  delete params.skip;
  delete params.limite;

  // Detecta parametros nao identificados no construtor
  // de filtros da API Mailing atualmente analisado.
  const naoReconhecidos = Object.keys(params)
    .filter(
      (chave) =>
        !FILTROS_MAILING_RECONHECIDOS.has(chave)
    );

  if (naoReconhecidos.length) {
    emitirLog(log, {
      evento: 'filtros_nao_reconhecidos',
      etapa: 'clientes_mailing',
      origem: 'mailing',

      parametros_nao_reconhecidos_pelo_mailing:
        naoReconhecidos,
    });
  }

  // Nao fixar filtros para COMBO, CONSIG, DEBITO etc.
  // A propria API Mailing interpreta os parametros.
  for (
    let pagina = 0;
    pagina < MAX_PAGES;
    pagina++
  ) {
    const skip =
      pagina * MAILING_PAGE_SIZE;

    const resposta = await getJson(
      mailing.url,
      'beneficios/consulta',
      {
        ...params,
        skip,
        limite: MAILING_PAGE_SIZE,
      },
      mailing.token,
      {
        etapa: 'clientes_mailing',
        origem: 'mailing',
        pagina: pagina + 1,
        skip,
        limite: MAILING_PAGE_SIZE,
      },
      log
    );

    if (resposta.semResultados) {
      return {
        registros,
        filtros: params,
        naoReconhecidos,
      };
    }

    if (
      !Array.isArray(
        resposta.beneficios
      )
    ) {
      throw new Error(
        'Mailing nao retornou beneficios[]'
      );
    }

    if (
      resposta.beneficios.length >
      MAILING_PAGE_SIZE
    ) {
      throw new Error(
        'Mailing retornou mais registros que o limite solicitado'
      );
    }

    registros.push(
      ...resposta.beneficios
    );

    if (
      resposta.beneficios.length <
      MAILING_PAGE_SIZE
    ) {
      return {
        registros,
        filtros: params,
        naoReconhecidos,
      };
    }
  }

  throw new Error(
    'Limite de paginas do Mailing atingido'
  );
}

// ============================================================
// INDEXAR CLIENTES POR CPF
// ============================================================

function indexarPorCpf(
  registros,
  extrairCpf,
  origem
) {
  const mapa = new Map();
  const semCpf = [];
  const duplicados = [];

  for (const item of registros) {
    const cpf = normalizarCpf(
      extrairCpf(item)
    );

    if (!cpf) {
      semCpf.push(item);
      continue;
    }

    if (mapa.has(cpf)) {
      duplicados.push(item);
    } else {
      mapa.set(
        cpf,
        item
      );
    }
  }

  return {
    mapa,
    semCpf,
    duplicados,
    origem,
  };
}

// ============================================================
// COMPARAR CLIENTES
// ============================================================

function comparar(
  conteudoMonitor,
  conteudoMailing
) {
  const monitor = indexarPorCpf(
    conteudoMonitor.registros,
    (r) =>
      r.cpf ??
      r.dados_cliente?.cpf,
    'monitor'
  );

  const mailing = indexarPorCpf(
    conteudoMailing.registros,
    (r) =>
      r.cliente?.cpf,
    'mailing'
  );

  const apenasMailing = [];
  const apenasMonitor = [];

  let comuns = 0;

  for (
    const [cpf, registro]
    of mailing.mapa
  ) {
    if (monitor.mapa.has(cpf)) {
      comuns++;
    } else {
      apenasMailing.push({
        cpf,
        origem: 'mailing',
        registro,
      });
    }
  }

  for (
    const [cpf, registro]
    of monitor.mapa
  ) {
    if (!mailing.mapa.has(cpf)) {
      apenasMonitor.push({
        cpf,
        origem: 'monitor',
        registro,
      });
    }
  }

  return {
    resumo: {
      registros_monitor:
        conteudoMonitor.registros.length,

      registros_mailing:
        conteudoMailing.registros.length,

      cpfs_unicos_monitor:
        monitor.mapa.size,

      cpfs_unicos_mailing:
        mailing.mapa.size,

      cpfs_em_ambos:
        comuns,

      somente_no_mailing:
        apenasMailing.length,

      somente_no_monitor:
        apenasMonitor.length,

      total_status_sucesso_monitor:
        conteudoMonitor.registros.filter(
          (r) =>
            r.status_consulta ===
            'sucesso'
        ).length,

      total_status_erro_monitor:
        conteudoMonitor.registros.filter(
          (r) =>
            r.status_consulta ===
            'erro'
        ).length,

      sem_cpf_monitor:
        monitor.semCpf.length,

      sem_cpf_mailing:
        mailing.semCpf.length,

      cpfs_duplicados_monitor:
        monitor.duplicados.length,

      cpfs_duplicados_mailing:
        mailing.duplicados.length,
    },

    divergencias: {
      somente_no_mailing:
        apenasMailing,

      somente_no_monitor:
        apenasMonitor,

      sem_cpf_monitor:
        monitor.semCpf,

      sem_cpf_mailing:
        mailing.semCpf,

      duplicados_monitor:
        monitor.duplicados,

      duplicados_mailing:
        mailing.duplicados,
    },
  };
}

// ============================================================
// FUNCAO PRINCIPAL
// ============================================================

export async function compararClientes(
  idMonitor,
  { log } = {}
) {
  const monitor = {
    url:
      config('URL_MONITOR'),

    token:
      tokenConfigurado(
        'TOKEN_MONITOR'
      ),

    empresa:
      config(
        'ID_EMPRESA_MONITOR'
      ),
  };

  const mailing = {
    url:
      config('URL_MAILING'),

    token:
      tokenConfigurado(
        'TOKEN_MAILING'
      ),
  };

  // 1. Buscar dados da campanha.
  const campanha =
    await buscarCampanha(
      idMonitor,
      monitor,
      log
    );

  // 2. Buscar clientes nas duas APIs
  // e calcular novamente o total_beneficios
  // diretamente na Mailing.
  const [
    resultadoMonitor,
    resultadoMailing,
    quantidadeMailing,
  ] = await Promise.all([
    buscarClientesMonitor(
      idMonitor,
      monitor,
      log
    ),

    buscarClientesMailing(
      campanha.query_consulta_base,
      mailing,
      log
    ),

    buscarTotalBeneficiosMailing(
      campanha.query_consulta_base,
      mailing,
      log
    ),
  ]);

  // 3. Comparar CPFs.
  const comparacao =
    comparar(
      resultadoMonitor,
      resultadoMailing
    );

  // 4. Avisar sobre filtros possivelmente ignorados.
  const avisos =
    resultadoMailing
      .naoReconhecidos
      .length
      ? [
          `Filtros da campanha nao identificados no construtor atual do Mailing: ${
            resultadoMailing
              .naoReconhecidos
              .join(', ')
          }. Foram enviados, mas podem ter sido ignorados pela API.`,
        ]
      : [];

  return {
    sucesso: true,

    consultado_em:
      new Date().toISOString(),

    campanha: {
      id:
        campanha.id,

      nome:
        campanha.nome,

      origem:
        campanha.origem,

      status:
        campanha.status,

      data_criacao:
        campanha.data_criacao,

      total_declarado:
        campanha.total,

      qtd_cli_consultados:
        campanha.qtd_cli_consultados,

      qtd_clientes_certos:
        campanha.qtd_clientes_certos,

      qtd_clientes_errados:
        campanha.qtd_clientes_errados,

      total_registros_monitor:
        resultadoMonitor.total,

      // Total calculado diretamente
      // pela API Mailing usando
      // os mesmos filtros da campanha.
      total_beneficios_mailing:
        quantidadeMailing
          .total_beneficios,

      // Total bruto disponivel na Mailing
      // antes de aplicar o limite
      // configurado na solicitacao.
      total_disponivel_mailing:
        quantidadeMailing
          .total_disponivel,

      limite_campanha_mailing:
        quantidadeMailing
          .limite_campanha,

      // Quantidade efetivamente coletada
      // pela auditoria usando
      // /beneficios/consulta.
      total_registros_mailing_coletados:
        resultadoMailing
          .registros
          .length,

      // Diferenca simples entre
      // o total atual calculado pela Mailing
      // e o total existente no Monitor.
      diferenca_total_beneficios_monitor:
        quantidadeMailing
          .total_beneficios -
        resultadoMonitor.total,

      // Mantido por compatibilidade
      // com a interface.
      filtros_aplicados:
        resultadoMailing.filtros,

      filtros_nao_reconhecidos:
        resultadoMailing
          .naoReconhecidos,
    },

    resumo: {
      ...comparacao.resumo,

      total_beneficios_mailing:
        quantidadeMailing
          .total_beneficios,

      total_disponivel_mailing:
        quantidadeMailing
          .total_disponivel,

      limite_campanha_mailing:
        quantidadeMailing
          .limite_campanha,

      total_registros_mailing_coletados:
        resultadoMailing
          .registros
          .length,

      diferenca_total_beneficios_monitor:
        quantidadeMailing
          .total_beneficios -
        resultadoMonitor.total,
    },

    divergencias:
      comparacao.divergencias,

    observacoes: [
      'Comparacao por CPF entre registros ClienteConsulta do Monitor e a selecao atual da API Mailing.',

      'Registros do Monitor incluem sucessos e erros; nao representam necessariamente apenas clientes inseridos na discadora.',

      'Diferencas podem ser decorrentes de blacklist, pipeline, limite da campanha e alteracoes posteriores nos dados de origem.',

      'A rota de consulta do Mailing retorna dados resumidos, nao o cadastro completo de cada cliente.',

      ...avisos,
    ],
  };
}