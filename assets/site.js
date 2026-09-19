/* Busca local e navegação do caderno. Sem bibliotecas nem serviços externos. */
'use strict';

const RadarSearch = (() => {
  const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  const tokens = value => fold(value).trim().split(/\s+/).filter(Boolean);
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = (value, token) => token.length <= 2
    ? new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(token)}($|[^\\p{L}\\p{N}])`, 'u').test(value)
    : value.includes(token);
  const cache = new WeakMap();

  function bounds(period, config) {
    if (period === 'ultima') return [config.latest_start, config.cutoff];
    if (period === '4-semanas') {
      const day = new Date(config.cutoff + 'T12:00:00Z');
      day.setUTCDate(day.getUTCDate() - 27);
      return [day.toISOString().slice(0, 10), config.cutoff];
    }
    if (period === 'anterior') return ['', '2025-07-31'];
    if (/^\d{4}$/.test(period)) return [period + '-01-01', period + '-12-31'];
    return ['', '9999-12-31'];
  }

  function occurrences(item, state, config) {
    const [start, end] = bounds(state.periodo, config);
    return (item.occurrences || []).filter(occ => (!state.pessoa || occ.by === state.pessoa)
      && (!state.periodo || (occ.date >= start && occ.date <= end)));
  }

  function score(item, query, topics) {
    if (!query.length) return 0;
    if (!cache.has(item)) cache.set(item, [
      fold(item.title), fold((item.topics || []).map(key => topics[key] || key).join(' ')),
      fold(item.description), fold([item.content, ...(item.people || []), item.domain].join(' ')),
    ]);
    const fields = cache.get(item);
    let result = 0;
    for (const token of query) {
      const field = fields.findIndex(text => matches(text, token));
      if (field < 0) return -1;
      result += [12, 8, 4, 1][field];
    }
    return result;
  }

  function search(items, state, config) {
    const query = tokens(state.q);
    const [start, end] = bounds(state.periodo, config);
    const found = [];
    for (const item of items) {
      if (state.tipo && state.tipo !== item.kind) continue;
      if (state.tema && !(item.topics || []).includes(state.tema)) continue;
      let date = item.date;
      if (item.kind === 'material' && (state.pessoa || state.periodo)) {
        const selected = occurrences(item, state, config);
        if (!selected.length) continue;
        date = selected.reduce((last, occ) => occ.date > last ? occ.date : last, '');
      } else {
        if (state.pessoa && !(item.people || []).includes(state.pessoa)) continue;
        if (state.periodo && (!item.date || item.date < start || (item.start || item.date) > end)) continue;
      }
      const relevance = score(item, query, config.topics);
      if (relevance >= 0) found.push({item, date, relevance});
    }
    return found.sort((a, b) => {
      if (state.ordem === 'auto' && query.length && a.relevance !== b.relevance) return b.relevance - a.relevance;
      const dates = (state.ordem === 'antigos' ? 1 : -1) * a.date.localeCompare(b.date);
      return dates || a.item.id.localeCompare(b.item.id);
    });
  }
  return {fold, tokens, matches, bounds, occurrences, score, search};
})();

if (typeof module !== 'undefined') module.exports = RadarSearch;

if (typeof document !== 'undefined') {
  let toastTimer;
  function toast(message) {
    const box = document.getElementById('toast');
    box.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.textContent = ''; }, 4500);
  }
  async function copyLink(value) {
    try {
      await navigator.clipboard.writeText(value);
      toast('Link copiado. Pronto para continuar a conversa.');
    } catch {
      toast('Não foi possível copiar. Copie o endereço pela barra do navegador.');
    }
  }
  document.querySelectorAll('[data-copy-link]').forEach(button => {
    button.addEventListener('click', () => copyLink(location.href));
  });
  document.querySelectorAll('[data-share-whatsapp]').forEach(link => {
    link.href = 'https://wa.me/?text=' + encodeURIComponent(document.title + '\n' + location.href);
  });
  const toc = document.querySelector('.toc');
  if (toc) {
    const desktop = matchMedia('(min-width: 901px)');
    const adapt = () => { toc.open = desktop.matches; };
    adapt();
    desktop.addEventListener('change', adapt);
  }

  const explorer = document.querySelector('[data-explorer]');
  if (explorer) startExplorer(explorer);

  function startExplorer(root) {
    const base = document.body.dataset.base || '';
    const defaults = {q: '', tipo: root.dataset.defaultKind, periodo: '', tema: '', pessoa: '', ordem: 'auto', pagina: 1};
    const controls = {q: 'query', tipo: 'kind', periodo: 'period', tema: 'topic', pessoa: 'person', ordem: 'sort'};
    const get = id => document.getElementById(id);
    const results = get('results');
    let state, config, editionData, materialData, request = 0, inputTimer;
    let configPending, editionsPending, materialsPending;
    const number = value => value.toLocaleString('pt-BR');
    const dateLabel = value => value ? new Date(value + 'T12:00:00Z').toLocaleDateString('pt-BR', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'}) : 'Data não informada';
    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const link = (text, url, external = false) => {
      const anchor = node('a', '', text);
      anchor.href = url;
      if (external) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
      return anchor;
    };

    async function fetchJSON(file) {
      const response = await fetch(base + 'data/' + file);
      if (!response.ok) throw new Error('Acervo indisponível');
      return response.json();
    }
    async function loadConfig() {
      if (!configPending) configPending = fetchJSON('config.json').then(data => {
        config = data;
        for (const person of config.people) get('person').add(new Option(person, person));
        return data;
      }).catch(error => { configPending = null; throw error; });
      return configPending;
    }
    async function loadEditions() {
      if (!editionsPending) editionsPending = fetchJSON('editions.json').then(data => {
        editionData = data; return data;
      }).catch(error => { editionsPending = null; throw error; });
      return editionsPending;
    }
    async function loadMaterials() {
      if (!materialsPending) materialsPending = fetchJSON('materials.json').then(data => {
        materialData = data; return data;
      }).catch(error => { materialsPending = null; throw error; });
      return materialsPending;
    }
    function readURL() {
      const params = new URLSearchParams(location.search);
      state = {...defaults};
      for (const key of Object.keys(controls)) if (params.has(key)) state[key] = params.get(key);
      state.q = state.q.slice(0, 200);
      state.pagina = Math.min(100000, Math.max(1, Math.floor(Number(params.get('pagina')) || 1)));
    }
    function fillControls() {
      for (const [key, id] of Object.entries(controls)) {
        const control = get(id);
        if (key !== 'q' && (key !== 'pessoa' || config) && ![...control.options].some(option => option.value === state[key])) state[key] = defaults[key];
        control.value = state[key];
      }
    }
    function syncURL(mode = 'push') {
      const params = new URLSearchParams();
      for (const key of Object.keys(controls)) if (state[key] !== defaults[key]) params.set(key, state[key]);
      if (state.pagina > 1) params.set('pagina', state.pagina);
      const url = location.pathname + (params.size ? '?' + params.toString() : '');
      if (url !== location.pathname + location.search) history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', url);
    }
    function readControls() {
      for (const [key, id] of Object.entries(controls)) state[key] = get(id).value;
      state.pagina = 1;
      syncURL();
      render();
    }
    function reset() {
      clearTimeout(inputTimer);
      state = {...defaults};
      fillControls();
      syncURL();
      render();
      get('query').focus();
    }
    function personLink(name) {
      if (name === 'Participante do grupo') return document.createTextNode(name);
      const params = new URLSearchParams({tipo: 'material', pessoa: name});
      return link(name, base + 'explorar.html?' + params.toString());
    }
    function credit(names, prefix) {
      const paragraph = node('p', 'result-credit', prefix);
      names.slice(0, 3).forEach((name, index) => {
        if (index) paragraph.append(', ');
        paragraph.append(personLink(name));
      });
      if (names.length > 3) paragraph.append(` e mais ${names.length - 3}`);
      return paragraph;
    }
    function renderResult(entry) {
      const {item, date} = entry;
      const article = node('article', 'result');
      article.dataset.id = item.id;
      const aside = node('div', 'result-aside');
      aside.append(node('span', 'result-kind', item.kind === 'material' ? item.format : item.kind === 'tema' ? 'Na conversa' : 'Edição'));
      aside.append(node('span', '', item.kind === 'material'
        ? (item.date_source === 'edition' ? 'Na edição de ' : '') + dateLabel(date) : item.period));
      const body = node('div');
      const title = node('h2');
      title.append(link(item.title + (item.kind === 'material' ? ' ↗' : ''), item.kind === 'material' ? item.url : base + item.url, item.kind === 'material'));
      body.append(title, node('p', 'result-description', item.description));
      const actions = node('div', 'result-actions');
      if (item.kind === 'material') {
        const selected = RadarSearch.occurrences(item, state, config);
        const names = [...new Set(selected.filter(occ => occ.date === date).map(occ => occ.by))];
        body.append(credit(names.length ? names : ['Participante do grupo'], item.date_source === 'edition' ? 'Referenciado no resumo · ' : 'Compartilhado por '));
        if (date !== item.date) body.append(node('p', 'source-note', 'Último compartilhamento no grupo: ' + dateLabel(item.date) + '. A data acima corresponde aos filtros.'));
        actions.append(node('span', 'domain', item.domain));
        if (item.context_url) actions.append(link(item.context_kind === 'edition' ? 'Ver a edição do período →' : 'Ver na conversa →', base + item.context_url));
        if (item.occurrences.length) {
          const historyButton = node('button', '', item.repeated ? `Voltou à conversa · ${item.occurrences.length} compartilhamentos` : 'Ver compartilhamento');
          historyButton.type = 'button';
          historyButton.setAttribute('aria-expanded', 'false');
          historyButton.setAttribute('aria-controls', 'history-' + item.id);
          const history = node('div', 'occurrence-list');
          history.id = 'history-' + item.id;
          history.hidden = true;
          historyButton.addEventListener('click', () => {
            if (!history.childElementCount) {
              history.append(node('p', '', 'Compartilhamentos registrados no acervo:'));
              for (const occ of item.occurrences) {
                const line = node('p', '', dateLabel(occ.date) + ' · ');
                line.append(personLink(occ.by));
                if (occ.edition) line.append(' · ', link('Edição →', base + occ.edition));
                history.append(line);
              }
            }
            history.hidden = !history.hidden;
            historyButton.setAttribute('aria-expanded', String(!history.hidden));
          });
          actions.append(historyButton);
          body.append(actions, history);
        } else body.append(actions);
      } else {
        if (item.partial) actions.append(node('span', 'pill partial', 'Edição parcial'));
        actions.append(link(item.kind === 'tema' ? 'Ler este assunto →' : 'Ler a edição →', base + item.url));
        body.append(actions);
      }
      const topics = node('div', 'result-topics');
      for (const key of item.topics || []) if (config.topics[key]) topics.append(node('span', '', config.topics[key]));
      body.append(topics);
      article.append(aside, body);
      return article;
    }
    async function render({focusResults = false} = {}) {
      const current = ++request;
      results.setAttribute('aria-busy', 'true');
      get('result-count').textContent = 'Carregando o acervo…';
      get('load-error').hidden = true;
      get('empty-state').hidden = true;
      get('pagination').hidden = true;
      try {
        await loadConfig();
        if (current !== request) return;
        fillControls();
        const needsMaterials = !state.tipo || state.tipo === 'material';
        const needsEditions = !state.tipo || state.tipo !== 'material';
        await Promise.all([needsMaterials ? loadMaterials() : null, needsEditions ? loadEditions() : null]);
        if (current !== request) return;
        const items = [...(needsEditions ? editionData : []), ...(needsMaterials ? materialData : [])];
        const found = RadarSearch.search(items, state, config);
        const pages = Math.max(1, Math.ceil(found.length / 24));
        state.pagina = Math.min(state.pagina, pages);
        syncURL('replace');
        const first = (state.pagina - 1) * 24;
        const visible = found.slice(first, first + 24);
        results.replaceChildren(...visible.map(renderResult));
        get('result-count').textContent = `${number(found.length)} ${found.length === 1 ? 'resultado' : 'resultados'}` + (found.length ? ` · ${number(first + 1)}–${number(first + visible.length)}` : '');
        get('empty-state').hidden = !!found.length;
        get('pagination').hidden = pages <= 1;
        get('page-status').textContent = `${state.pagina} de ${pages}`;
        get('prev-page').disabled = state.pagina <= 1;
        get('next-page').disabled = state.pagina >= pages;
        if (focusResults) {
          get('result-count').tabIndex = -1;
          get('result-count').focus({preventScroll: true});
          get('result-count').scrollIntoView({block: 'start', behavior: 'instant'});
        }
      } catch {
        if (current !== request) return;
        results.replaceChildren();
        get('result-count').textContent = 'Acervo indisponível no momento';
        get('load-error').hidden = false;
      } finally {
        if (current === request) results.setAttribute('aria-busy', 'false');
      }
    }
    get('explore-form').addEventListener('submit', event => {
      event.preventDefault(); clearTimeout(inputTimer); readControls();
    });
    get('query').addEventListener('input', () => {
      clearTimeout(inputTimer); inputTimer = setTimeout(readControls, 250);
    });
    for (const id of Object.values(controls).filter(id => id !== 'query')) get(id).addEventListener('change', () => { clearTimeout(inputTimer); readControls(); });
    get('clear-filters').addEventListener('click', reset);
    document.querySelectorAll('[data-reset-filters]').forEach(button => button.addEventListener('click', reset));
    get('retry-load').addEventListener('click', () => render());
    get('prev-page').addEventListener('click', () => { state.pagina--; syncURL(); render({focusResults: true}); });
    get('next-page').addEventListener('click', () => { state.pagina++; syncURL(); render({focusResults: true}); });
    window.addEventListener('popstate', () => { clearTimeout(inputTimer); readURL(); fillControls(); render(); });
    readURL();
    fillControls();
    render();
  }
}
