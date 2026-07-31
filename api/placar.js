// api/placar.js — Função serverless (Vercel) que lê o ClickUp AO VIVO
// e devolve o placar do PDI Ciclo 4 já calculado.
// A chave do ClickUp fica só aqui no servidor (env var CLICKUP_TOKEN), nunca no navegador.

// Limpa qualquer caractere invisível/não-ASCII que possa ter grudado no token via copiar/colar
const TOKEN = (process.env.CLICKUP_TOKEN || "").replace(/[^\x20-\x7E]/g, "").trim();

// Listas do folder "PDI Ciclo 4" (RH excluída de propósito)
const LISTS = {
  "901321213835": "Projetos",
  "901321220655": "Sonar",
  "901321256630": "Comercial",
  "901321276853": "Marketing",
  "901321257373": "Financeiro",
  "901321302520": "Operação",
  "901321365938": "FTL",
  "901327861337": "Diretoria",
};

const F_ATIV = "e45f3d4a-91fd-4a37-8d92-076e75b8da6b"; // Atividade (drop_down: Livro/Curso/Evento)
const F_META = "ea7cd29c-dab8-474c-8001-42534715c59f"; // Nº Páginas/Horas (number)
const F_PROG = "4293eb97-98f5-4b10-8418-109ae2a74557"; // Progresso (manual_progress, current 0-100)

const META_CURSO_HORAS = 25; // meta de horas de curso do ciclo (cursos% = horas ÷ 25)

// Pessoas desligadas a excluir por nome (editar aqui se alguém sair). RH já é excluída por lista.
const EXCLUDE = new Set([]);

function cf(task, id) {
  return (task.custom_fields || []).find((f) => f.id === id);
}

function dropdownLabel(field) {
  if (!field || field.value === undefined || field.value === null || field.value === "") return null;
  const opts = (field.type_config && field.type_config.options) || [];
  let opt = opts.find((o) => String(o.orderindex) === String(field.value));
  if (!opt) opt = opts.find((o) => o.id === field.value);
  return opt ? opt.name : null;
}

function progressCurrent(field) {
  if (!field || field.value == null) return 0;
  const v = field.value;
  if (typeof v === "object") {
    if (v.current != null) return parseFloat(v.current) || 0;
    if (v.percent_completed != null) return (parseFloat(v.percent_completed) || 0) * 100;
    return 0;
  }
  return parseFloat(v) || 0;
}

function numVal(field) {
  if (!field || field.value == null) return 0;
  return parseFloat(field.value) || 0;
}

function hasCiclo4(task) {
  return (task.tags || []).some((t) => (t.name || "").toLowerCase().trim() === "ciclo 4");
}

function isPersonCardName(name) {
  const n = (name || "").trim().toLowerCase();
  if (!n) return false;
  if (n.startsWith("modelo")) return false;
  if (n.includes("exemplo")) return false; // "[EXEMPLO – modelo novo] ..."
  if (n.includes(":") || n.includes("*")) return false; // título de livro/curso solto na raiz, não é pessoa
  return true;
}

async function fetchList(listId) {
  const tasks = [];
  for (let page = 0; page < 20; page++) {
    const url = `https://api.clickup.com/api/v2/list/${listId}/task?subtasks=true&include_closed=true&page=${page}`;
    const r = await fetch(url, { headers: { Authorization: TOKEN } });
    if (!r.ok) throw new Error(`ClickUp respondeu ${r.status} na lista ${listId}`);
    const data = await r.json();
    const batch = data.tasks || [];
    tasks.push(...batch);
    if (data.last_page || batch.length < 100) break;
  }
  return tasks;
}

module.exports = async (req, res) => {
  try {
    if (!TOKEN) throw new Error("CLICKUP_TOKEN não configurado na Vercel");

    const people = {}; // parentId -> agregado da pessoa
    const ensure = (id, name, team) => {
      if (!people[id]) people[id] = { n: name, t: team, books: [], hours: 0, pages: 0 };
      return people[id];
    };

    for (const [listId, team] of Object.entries(LISTS)) {
      const tasks = await fetchList(listId);
      // 1ª passada: cards-pessoa (tarefas de topo). Ignora atividades soltas na raiz
      // (livro/curso órfão): card-pessoa NÃO tem o campo "Atividade" preenchido.
      for (const t of tasks) {
        if (!t.parent && isPersonCardName(t.name) && !dropdownLabel(cf(t, F_ATIV)) && !EXCLUDE.has((t.name || "").trim())) {
          ensure(t.id, (t.name || "").trim(), team);
        }
      }
      // 2ª passada: subtarefas (atividades) com tag "ciclo 4"
      for (const t of tasks) {
        if (!t.parent || !hasCiclo4(t)) continue;
        const owner = people[t.parent]; // dono = card onde a subtarefa aparece
        if (!owner) continue; // órfã ou dono excluído
        const ativ = dropdownLabel(cf(t, F_ATIV));
        if (!ativ || ativ === "Evento") continue; // Evento não pontua
        const meta = numVal(cf(t, F_META));
        const cur = Math.max(0, progressCurrent(cf(t, F_PROG)));
        const frac = cur / 100;
        if (ativ === "Livro") {
          owner.pages += frac * meta;
          owner.books.push(cur);
        } else if (ativ === "Curso") {
          owner.hours += frac * meta;
        }
      }
    }

    const P = Object.values(people).map((p) => {
      const bookPct = p.books.length ? p.books.reduce((a, b) => a + b, 0) / p.books.length : 0;
      const cursosPct = (p.hours / META_CURSO_HORAS) * 100;
      const pv = Math.min(100, Math.round(0.5 * bookPct + 0.5 * cursosPct));
      return {
        n: p.n,
        t: p.t,
        p: pv,
        lv: Math.round(bookPct * 10) / 10,
        hrs: Math.round(p.hours * 10) / 10,
        pag: Math.round(p.pages),
        py: pv, // ao vivo não guarda "ontem"; badge de maior alta fica desligado
      };
    });

    // Dedup por nome (cards duplicados da mesma pessoa): fica o registro mais ativo
    const byName = {};
    for (const row of P) {
      const key = row.n.toLowerCase();
      const cur = byName[key];
      if (!cur || (row.pag + row.hrs * 10) > (cur.pag + cur.hrs * 10)) byName[key] = row;
    }
    const P2 = Object.values(byName).sort((a, b) => b.p - a.p || b.pag - a.pag || a.n.localeCompare(b.n));

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({ updatedAt: new Date().toISOString(), count: P2.length, P: P2 });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
