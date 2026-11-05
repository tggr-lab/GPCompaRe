/* search.js: Browse page search across variants and generic positions.
   Public: window.SiteSearch = { init(opts), classify(q) }.

   Reads the static index the generator writes to <site>/search/ (see
   website/page_generators/search_index.py). Nothing is fetched until the
   first variant or position search. The receptor search (site.js
   initBrowse) is left exactly as it was; this file only adds a second tab,
   reads ?q= / ?mode= from the URL, and shows a hint under the receptor table
   when a receptor query looks like a variant or a position. */
(function () {
  'use strict';

  var AA3 = {
    A: 'Ala', R: 'Arg', N: 'Asn', D: 'Asp', C: 'Cys', Q: 'Gln', E: 'Glu', G: 'Gly',
    H: 'His', I: 'Ile', L: 'Leu', K: 'Lys', M: 'Met', F: 'Phe', P: 'Pro', S: 'Ser',
    T: 'Thr', W: 'Trp', Y: 'Tyr', V: 'Val'
  };
  var AA1 = {};
  Object.keys(AA3).forEach(function (k) { AA1[AA3[k].toUpperCase()] = k; });

  var NA = 'not available';
  var opts = {};
  var baseUrl = null;
  var cache = {};
  var meta = null;
  var aliases = null;
  var lastRun = 0;

  // ------------------------------------------------------------ helpers
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function aa3(c) { return AA3[String(c).toUpperCase()] || null; }
  function cap3(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1, 3).toLowerCase(); }

  function fetchJSON(path) {
    if (!cache[path]) {
      cache[path] = fetch(new URL(path, baseUrl).href).then(function (r) {
        if (!r.ok) throw new Error(r.status + ' ' + path);
        return r.json();
      });
      cache[path].catch(function () { delete cache[path]; });
    }
    return cache[path];
  }
  function loadMeta() { return fetchJSON('meta.json').then(function (m) { meta = m; return m; }); }
  function loadVariants(gid) { return fetchJSON('variants/' + gid + '.json'); }

  function buildAliases() {
    if (aliases) return aliases;
    aliases = {};
    (window.GPCR_DATA || []).forEach(function (d) {
      [d.gene_name, d.uniprot_name, d.gpcr_id, String(d.gpcr_id || '').replace(/_human$/i, '')]
        .forEach(function (k) { if (k) aliases[String(k).toUpperCase()] = d; });
    });
    return aliases;
  }
  function receptorByToken(t) { return buildAliases()[String(t).toUpperCase()] || null; }
  function receptorLabel(d) {
    var g = d.gene_name && d.gene_name !== d.uniprot_name ? ' (' + d.gene_name + ')' : '';
    return d.uniprot_name + g;
  }
  function reportHref(gid, hash) {
    return (opts.reportPathPrefix || '../reports/') + gid + '.html' + (hash ? '#' + hash : '');
  }

  // ------------------------------------------------------------ parsing
  function parseGeneric(t) {
    var m = /^(\d{1,2})\.(\d{2,3})(?:x(\d{2,3}))?$/i.exec(t);
    if (m) return { seg: m[1], bw: m[1] + '.' + m[2], x: m[3] || null, text: t };
    m = /^(\d{1,2})x(\d{2,3})$/i.exec(t);
    if (m) return { seg: m[1], bw: null, x: m[2], text: t };
    return null;
  }

  function parseChange(t) {
    var m = /^(?:p\.)?([A-Za-z]{3})(\d+)([A-Za-z]{3})$/.exec(t);
    if (m && AA1[m[1].toUpperCase()] && AA1[m[3].toUpperCase()]) {
      return { kind: 'protein', pos: +m[2], hgvsp: 'p.' + cap3(m[1]) + m[2] + cap3(m[3]) };
    }
    m = /^(?:p\.)?([A-Za-z])(\d+)([A-Za-z])$/.exec(t);
    if (m && aa3(m[1]) && aa3(m[3])) {
      return { kind: 'protein', pos: +m[2], hgvsp: 'p.' + aa3(m[1]) + m[2] + aa3(m[3]) };
    }
    m = /^(?:p\.)?([A-Za-z]{3}|[A-Za-z])?(\d+)$/.exec(t);
    if (m) {
      var ref = m[1] ? (m[1].length === 3 ? cap3(m[1]) : aa3(m[1])) : null;
      if (m[1] && !(ref && AA1[ref.toUpperCase()])) return null;
      return { kind: 'residue', pos: +m[2], ref: ref };
    }
    if (/^c\.\S+$/i.test(t)) return { kind: 'dna', hgvsc: t.toLowerCase() };
    return null;
  }

  /* Returns {type, ...}: empty | rsid | gnomad | position | variant | receptor |
     need-receptor | unknown. `receptor` = a receptor name alone. */
  function classify(q) {
    var s = String(q || '').trim().replace(/\s+/g, ' ');
    if (!s) return { type: 'empty' };
    var m = /^rs(\d+)$/i.exec(s);
    if (m) return { type: 'rsid', num: m[1], text: 'rs' + m[1] };
    m = /^(?:chr)?(\d{1,2}|X|Y)[-:_ ](\d+)(?:[-:_ ]([ACGT]+)[-:_>/ ]([ACGT]+))?$/i.exec(s);
    if (m) {
      var chrom = m[1].toUpperCase();
      var id = chrom + '-' + m[2] + (m[3] ? '-' + m[3].toUpperCase() + '-' + m[4].toUpperCase() : '');
      return { type: 'gnomad', chrom: chrom, pos: +m[2], id: id, exact: !!m[3] };
    }
    var g = parseGeneric(s);
    if (g) return { type: 'position', generic: g };

    var toks = s.split(/[\s:,;]+/).filter(Boolean);
    var rec = null, rest = [];
    toks.forEach(function (t) {
      var d = !rec ? receptorByToken(t) : null;
      if (d) rec = d; else rest.push(t);
    });
    if (rec && rest.length === 0) return { type: 'receptor', receptor: rec };
    if (rec && rest.length === 1) {
      var gg = parseGeneric(rest[0]);
      if (gg) return { type: 'position', generic: gg, receptor: rec };
      var ch = parseChange(rest[0]);
      if (ch) return { type: 'variant', receptor: rec, change: ch, text: rest[0] };
    }
    if (!rec && toks.length === 1 && parseChange(toks[0]) && /[A-Za-z]/.test(toks[0])) {
      return { type: 'need-receptor', text: toks[0] };
    }
    return { type: rec ? 'unknown-change' : 'unknown', receptor: rec, text: rest.join(' ') };
  }

  // ------------------------------------------------------------ rendering
  function setStatus(html, isError) {
    var el = document.getElementById('vsearch-status');
    el.innerHTML = html || '';
    el.classList.toggle('is-error', !!isError);
  }
  function setResults(html) { document.getElementById('vsearch-results').innerHTML = html || ''; }

  // `label` is repeated on each cell so the table can stack on a phone.
  function cell(label, v, cls) {
    var lab = ' data-label="' + esc(label) + '"';
    if (v === null || v === undefined || v === '' || v === (meta && meta.missing) || v === '-') {
      return '<td class="na"' + lab + '>' + NA + '</td>';
    }
    return '<td' + (cls ? ' class="' + cls + '"' : '') + lab + '>' + esc(v) + '</td>';
  }
  function classCell(v) {
    var lab = ' data-label="Pathogenicity"';
    if (!v || v === '-' || v === (meta && meta.missing)) return '<td class="na"' + lab + '>' + NA + '</td>';
    var b = String(v).toLowerCase();
    if (b === 'pathogenic' || b === 'benign' || b === 'ambiguous') {
      return '<td' + lab + '><span class="badge badge-' + b + '">' + esc(v) + '</span></td>';
    }
    return '<td' + lab + '>' + esc(v) + '</td>';
  }

  /* One card per (receptor, residue). `hits` = allele rows from the shard. */
  function residueCard(d, shard, pos, hits, vq) {
    var res = shard.res[String(pos)] || ['', '', ''];
    var all = shard.v.filter(function (a) { return a[0] === pos; });
    var others = all.filter(function (a) { return hits.indexOf(a) === -1; });
    var maxd = hits.length ? hits[0][6] : (all[0] ? all[0][6] : '');
    var hash = 'sec=sec-variants&res=' + pos + (vq ? '&vq=' + encodeURIComponent(vq) : '');
    var href = reportHref(d.gpcr_id, hash);
    var gn = res[1]
      ? '<span>Generic number <b>' + esc(res[1]) + '</b></span>'
      : '<span>Generic number <b class="na">' + NA + '</b></span>';
    var html = '<article class="vres-card">' +
      '<header class="vres-head">' +
        '<span class="vres-title"><a href="' + esc(reportHref(d.gpcr_id)) + '">' + esc(receptorLabel(d)) + '</a>' +
        ' residue ' + esc((res[0] || '') + pos) + '</span>' +
        '<span class="vres-meta">' + gn +
          (res[2] ? '<span>Segment <b>' + esc(res[2]) + '</b></span>' : '') +
          (maxd && maxd !== '-' ? '<span title="Max |ΔRRCS| at this position, as in the report\'s variant table">Max |ΔRRCS| <b>' + esc(maxd) + '</b></span>' : '') +
        '</span>' +
        '<a class="btn btn-ghost btn-sm vres-open" href="' + esc(href) + '">Open in report</a>' +
      '</header>' +
      '<div class="v2-table-scroll"><table class="v2-table vres-table"><thead><tr>' +
        '<th>Protein change</th><th>DNA change</th><th title="gnomAD variant ID (GRCh38 chromosome-position-ref-alt)">gnomAD variant</th>' +
        '<th>dbSNP</th><th title="Population frequency from gnomAD v4">Allele freq</th>' +
        '<th title="AlphaMissense score: 0 = benign-like, 1 = pathogenic-like">AM score</th>' +
        '<th title="AlphaMissense pathogenicity class">Pathogenicity</th>' +
        '<th title="Sequence conservation: 0 = variable, 1 = conserved">Conservation</th>' +
      '</tr></thead><tbody>';
    hits.forEach(function (a) {
      html += '<tr>' + cell('Protein change', a[1]) + cell('DNA change', a[2], 'mono') +
        cell('gnomAD variant', a[3], 'mono') +
        cell('dbSNP', a[10] && a[10].length ? a[10].join(', ') : '', 'mono') +
        cell('Allele freq', a[4], 'num') + cell('AM score', a[7], 'num') + classCell(a[8]) +
        cell('Conservation', a[9], 'num') + '</tr>';
    });
    html += '</tbody></table></div>';
    if (others.length) {
      var names = [];
      others.forEach(function (a) { if (names.indexOf(a[1]) === -1) names.push(a[1]); });
      html += '<p class="vsearch-hint vres-others">Also at this residue: ' +
        names.map(esc).join(', ') + '</p>';
    }
    return html + '</article>';
  }

  function groupCards(d, shard, hits, vqFor) {
    var byPos = {}, order = [];
    hits.forEach(function (a) {
      if (!byPos[a[0]]) { byPos[a[0]] = []; order.push(a[0]); }
      byPos[a[0]].push(a);
    });
    return order.map(function (pos) {
      return residueCard(d, shard, pos, byPos[pos], vqFor(byPos[pos]));
    }).join('');
  }

  function residuePrefix(a) {
    var m = /^p\.[A-Za-z]{3}\d+/.exec(a[1] || '');
    return m ? m[0] : String(a[0]);
  }
  function sameHgvsp(rows) {
    return rows.every(function (r) { return r[1] === rows[0][1]; }) ? rows[0][1] : residuePrefix(rows[0]);
  }

  function receptorRecord(i) {
    var r = meta.receptors[i];
    var d = buildAliases()[String(r[0]).toUpperCase()];
    return d || { gpcr_id: r[0], uniprot_name: r[1], gene_name: r[2], receptor_family: r[3] };
  }

  function noVariantsNote(d) {
    return '<strong>' + esc(receptorLabel(d)) + '</strong> has no variants in the database\'s variant table.';
  }

  // ------------------------------------------------------------ searches
  function searchVariant(c, out) {
    var d = c.receptor;
    return loadMeta().then(function () {
      var idx = meta.receptors.findIndex(function (r) { return r[0] === d.gpcr_id; });
      if (meta.with_variants.indexOf(idx) === -1) { out.s(noVariantsNote(d)); return; }
      return loadVariants(d.gpcr_id).then(function (shard) {
        var ch = c.change, hits;
        if (ch.kind === 'protein') {
          hits = shard.v.filter(function (a) { return String(a[1]).toLowerCase() === ch.hgvsp.toLowerCase(); });
        } else if (ch.kind === 'dna') {
          hits = shard.v.filter(function (a) { return String(a[2]).toLowerCase() === ch.hgvsc; });
        } else {
          hits = shard.v.filter(function (a) { return a[0] === ch.pos; });
        }
        if (!hits.length) {
          var label = ch.kind === 'protein' ? ch.hgvsp : (ch.kind === 'dna' ? c.text : 'residue ' + ch.pos);
          var nres = Object.keys(shard.res).length;
          var atPos = ch.pos && shard.res[String(ch.pos)];
          out.s('No allele matching <strong>' + esc(label) + '</strong> in the ' + esc(receptorLabel(d)) +
            ' variant table. That table lists ' + shard.v.length + ' alleles at ' + nres + ' residues' +
            (ch.pos ? (atPos ? '; residue ' + ch.pos + ' is one of them, with other changes (below).'
                             : '; residue ' + ch.pos + ' is not one of them.') : '.'));
          if (atPos) {
            var here = shard.v.filter(function (a) { return a[0] === ch.pos; });
            out.r(groupCards(d, shard, here, function (rows) { return residuePrefix(rows[0]); }));
          }
          return;
        }
        out.s(hits.length + ' allele' + (hits.length === 1 ? '' : 's') + ' in the ' +
          esc(receptorLabel(d)) + ' variant table.');
        out.r(groupCards(d, shard, hits, function (rows) {
          if (ch.kind === 'protein') return ch.hgvsp;
          if (ch.kind === 'dna') return rows[0][2];
          return residuePrefix(rows[0]);
        }));
      });
    });
  }

  function searchReceptor(c, out) {
    var d = c.receptor;
    return loadMeta().then(function () {
      var idx = meta.receptors.findIndex(function (r) { return r[0] === d.gpcr_id; });
      if (meta.with_variants.indexOf(idx) === -1) { out.s(noVariantsNote(d)); return; }
      return loadVariants(d.gpcr_id).then(function (shard) {
        out.s('All ' + shard.v.length + ' alleles at ' + Object.keys(shard.res).length +
          ' residues in the ' + esc(receptorLabel(d)) + ' variant table, ordered as in the report. ' +
          'Add a change to narrow it, for example <code>' + esc(d.gene_name || d.uniprot_name) + ' ' +
          esc(shard.v[0] ? shard.v[0][1] : 'p.Met159Ile') + '</code>.');
        out.r(groupCards(d, shard, shard.v, function (rows) { return residuePrefix(rows[0]); }));
      });
    });
  }

  function searchAcross(idxs, match, label, vqFor, out) {
    if (!idxs.length) {
      out.s('No allele matching <strong>' + esc(label) + '</strong> in any receptor\'s variant table.');
      return Promise.resolve();
    }
    return Promise.all(idxs.map(function (i) {
      var d = receptorRecord(i);
      return loadVariants(d.gpcr_id).then(function (shard) {
        return { d: d, shard: shard, hits: shard.v.filter(match) };
      });
    })).then(function (parts) {
      parts = parts.filter(function (p) { return p.hits.length; });
      var n = parts.reduce(function (s, p) { return s + p.hits.length; }, 0);
      if (!n) {
        out.s('No allele matching <strong>' + esc(label) + '</strong> in any receptor\'s variant table.');
        return;
      }
      out.s(n + ' allele' + (n === 1 ? '' : 's') + ' matching <strong>' + esc(label) + '</strong> in ' +
        parts.length + ' receptor' + (parts.length === 1 ? '' : 's') + '.');
      out.r(parts.map(function (p) { return groupCards(p.d, p.shard, p.hits, vqFor); }).join(''));
    });
  }

  function searchRsid(c, out) {
    var key = ('0' + (parseInt(c.num.slice(-2), 10) % meta.rsid_shards)).slice(-2);
    return fetchJSON('rsid/' + key + '.json').catch(function () { return {}; }).then(function (shard) {
      var idxs = shard[String(parseInt(c.num, 10))] || [];
      var rs = 'rs' + parseInt(c.num, 10);
      return searchAcross(idxs, function (a) { return (a[10] || []).indexOf(rs) !== -1; }, rs,
        function () { return rs; }, out);
    });
  }

  function searchGnomad(c, out) {
    var ranges = meta.gnomad_ranges[c.chrom] || [];
    var idxs = ranges.filter(function (r) { return r[0] <= c.pos && c.pos <= r[1]; }).map(function (r) { return r[2]; });
    var prefix = c.id + '-';
    return searchAcross(idxs, function (a) {
      return c.exact ? a[3] === c.id : String(a[3]).indexOf(prefix) === 0;
    }, c.id, function (rows) { return rows.length === 1 ? rows[0][2] : sameHgvsp(rows); }, out);
  }

  var posState = null;

  function searchPosition(c, out) {
    var g = c.generic;
    if (meta.position_shards.indexOf(g.seg) === -1) {
      out.s('No receptor has a residue at <strong>' + esc(g.text) + '</strong> in the GPCRdb numbering.');
      return Promise.resolve();
    }
    return fetchJSON('positions/' + g.seg + '.json').then(function (shard) {
      var keys = Object.keys(shard).filter(function (k) {
        var parts = k.split('x');
        if (g.bw && g.x) return k === g.bw + 'x' + g.x;
        if (g.bw) return parts[0] === g.bw;
        return parts[1] === g.x;
      });
      var rows = [];
      keys.forEach(function (k) {
        shard[k].forEach(function (e) {
          if (c.receptor && meta.receptors[e[0]][0] !== c.receptor.gpcr_id) return;
          var d = receptorRecord(e[0]);
          rows.push({ d: d, gn: k, seq: e[1], aa: e[2], delta: e[3] });
        });
      });
      if (!rows.length) {
        out.s(c.receptor
          ? esc(receptorLabel(c.receptor)) + ' has no residue at <strong>' + esc(g.text) + '</strong> in the GPCRdb numbering.'
          : 'No receptor has a residue at <strong>' + esc(g.text) + '</strong> in the GPCRdb numbering.');
        return;
      }
      var total = meta.receptors.length;
      var nRec = {};
      rows.forEach(function (r) { nRec[r.d.gpcr_id] = 1; });
      var count = Object.keys(nRec).length;
      var comp = {};
      rows.forEach(function (r) { comp[r.aa] = (comp[r.aa] || 0) + 1; });
      var compTxt = Object.keys(comp).sort(function (a, b) { return comp[b] - comp[a]; })
        .map(function (a) { return a + ' ' + comp[a]; }).join(', ');
      var miss = meta.positions_missing.length;
      out.s(c.receptor
        ? esc(receptorLabel(c.receptor)) + ' at <strong>' + esc(keys.join(', ')) + '</strong>.'
        : '<strong>' + count + ' of ' + total + '</strong> receptors have a residue at <strong>' +
          esc(keys.join(', ')) + '</strong> (GPCRdb numbering, as in the snake plots). Residues: ' + esc(compTxt) + '.' +
          (miss ? ' ' + miss + ' receptor' + (miss === 1 ? '' : 's') + ' could not be checked (no snake-plot numbering).' : ''));
      out.pos = { rows: rows, col: 'name', dir: 'asc' };
    });
  }

  var POS_COLS = [
    { key: 'name', label: 'Receptor' },
    { key: 'gene', label: 'Gene' },
    { key: 'family', label: 'Family' },
    { key: 'seq', label: 'Residue' },
    { key: 'gn', label: 'Generic number' },
    { key: 'delta', label: 'Max |ΔRRCS|', tip: 'Largest |ΔRRCS| among the contacts this residue makes, active minus inactive model' }
  ];

  function sortVal(r, key) {
    switch (key) {
      case 'name': return r.d.uniprot_name;
      case 'gene': return r.d.gene_name || '';
      case 'family': return r.d.receptor_family || '';
      case 'seq': return r.seq;
      case 'gn': return r.gn;
      case 'delta': return r.delta === null ? -1 : r.delta;
    }
    return '';
  }

  function renderPositions() {
    var st = posState;
    st.rows.sort(function (a, b) {
      var av = sortVal(a, st.col), bv = sortVal(b, st.col), r;
      if (typeof av === 'number') r = av - bv;
      else r = String(av).localeCompare(String(bv));
      if (r === 0) r = a.d.uniprot_name.localeCompare(b.d.uniprot_name);
      return st.dir === 'asc' ? r : -r;
    });
    var html = '<div class="v2-table-wrap vpos-wrap"><div class="v2-table-scroll"><table class="v2-table vpos-table"><thead><tr>';
    POS_COLS.forEach(function (c) {
      var s = st.col === c.key ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      html += '<th data-sort="' + c.key + '" tabindex="0" role="button" aria-sort="' + s + '"' +
        (c.tip ? ' title="' + esc(c.tip) + '"' : '') + '>' + esc(c.label) + '</th>';
    });
    html += '</tr></thead><tbody>';
    st.rows.forEach(function (r) {
      var href = reportHref(r.d.gpcr_id, 'sec=sec-snake&res=' + r.seq);
      html += '<tr>' +
        '<td><a href="' + esc(href) + '">' + esc(r.d.uniprot_name) + '</a></td>' +
        '<td>' + esc(r.d.gene_name || '') + '</td>' +
        '<td>' + esc(r.d.receptor_family || '') + '</td>' +
        '<td class="mono"><a href="' + esc(href) + '">' + esc(r.aa + r.seq) + '</a></td>' +
        '<td class="mono">' + esc(r.gn) + '</td>' +
        (r.delta === null ? '<td class="na num">no contacts</td>' : '<td class="num">' + r.delta.toFixed(2) + '</td>') +
        '</tr>';
    });
    html += '</tbody></table></div></div>';
    setResults(html);
    document.querySelectorAll('.vpos-table th[data-sort]').forEach(function (th) {
      var fire = function () {
        var k = th.getAttribute('data-sort');
        if (st.col === k) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
        else { st.col = k; st.dir = k === 'delta' ? 'desc' : 'asc'; }
        renderPositions();
        var again = document.querySelector('.vpos-table th[data-sort="' + k + '"]');
        if (again) again.focus();
      };
      th.addEventListener('click', fire);
      th.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
      });
    });
  }

  function run(q) {
    var c = classify(q);
    var my = ++lastRun;
    setResults('');
    if (c.type === 'empty') { setStatus(''); return; }
    if (c.type === 'need-receptor') {
      setStatus('Add a gene or receptor name to <strong>' + esc(c.text) + '</strong>, for example <code>F2RL1 ' + esc(c.text) + '</code>.');
      return;
    }
    if (c.type === 'unknown' || c.type === 'unknown-change') {
      setStatus(c.receptor
        ? 'Could not read <strong>' + esc(c.text) + '</strong> as a protein change. Use a form like <code>M159I</code>, <code>p.Met159Ile</code>, <code>159</code> or <code>c.477G&gt;A</code>.'
        : 'Not recognized. Search a gene or receptor with a change (<code>F2RL1 M159I</code>), an rsID, a gnomAD variant ID or a generic number (<code>6.48x48</code>). Receptor names and families are searched on the Receptors tab.');
      return;
    }
    setStatus('Searching\u2026');
    // Searches write into `out`; only the latest search reaches the page.
    var out = { status: '', err: false, results: '', pos: null,
                s: function (h, e) { out.status = h; out.err = !!e; },
                r: function (h) { out.results = h; } };
    var job;
    if (c.type === 'variant') job = searchVariant(c, out);
    else if (c.type === 'receptor') job = searchReceptor(c, out);
    else job = loadMeta().then(function () {
      if (c.type === 'rsid') return searchRsid(c, out);
      if (c.type === 'gnomad') return searchGnomad(c, out);
      return searchPosition(c, out);
    });
    job.then(function () {
      if (my !== lastRun) return;
      setStatus(out.status, out.err);
      if (out.pos) { posState = out.pos; renderPositions(); }
      else setResults(out.results);
    }, function () {
      if (my !== lastRun) return;
      setStatus('The search index could not be loaded. Check your connection and try again.', true);
    });
  }

  // ------------------------------------------------------------ page wiring
  function selectTab(which, focus) {
    var tabs = { receptors: document.getElementById('tab-receptors'), variants: document.getElementById('tab-variants') };
    Object.keys(tabs).forEach(function (k) {
      var on = k === which;
      tabs[k].setAttribute('aria-selected', on ? 'true' : 'false');
      tabs[k].tabIndex = on ? 0 : -1;
      document.getElementById(tabs[k].getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tabs[which].focus();
  }

  function setUrl(params) {
    var qs = params ? '?' + Object.keys(params).map(function (k) {
      return k + '=' + encodeURIComponent(params[k]);
    }).join('&') : '';
    try { history.replaceState(null, '', window.location.pathname + qs); } catch (e) {}
  }

  function submitVariant(q, writeUrl) {
    var input = document.getElementById('vsearch-input');
    input.value = q;
    if (writeUrl) setUrl(q ? { mode: 'variants', q: q } : { mode: 'variants' });
    run(q);
  }

  function isOtherKind(c) {
    return ['rsid', 'gnomad', 'position', 'variant', 'need-receptor'].indexOf(c.type) !== -1;
  }

  function init(o) {
    opts = o || {};
    baseUrl = new URL(opts.indexBase || '../search/', window.location.href);
    var tabR = document.getElementById('tab-receptors');
    var tabV = document.getElementById('tab-variants');
    if (!tabR || !tabV) return;

    [tabR, tabV].forEach(function (t) {
      t.addEventListener('click', function () {
        var which = t === tabV ? 'variants' : 'receptors';
        selectTab(which);
        if (which === 'variants') {
          var v = document.getElementById('vsearch-input');
          setUrl(v.value ? { mode: 'variants', q: v.value } : { mode: 'variants' });
          v.focus();
        } else {
          setUrl(null);
        }
      });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          (t === tabR ? tabV : tabR).click();
          (t === tabR ? tabV : tabR).focus();
        }
      });
    });

    document.getElementById('vsearch-form').addEventListener('submit', function (e) {
      e.preventDefault();
      submitVariant(document.getElementById('vsearch-input').value.trim(), true);
    });
    document.querySelectorAll('.vsearch-chip').forEach(function (b) {
      b.addEventListener('click', function () { submitVariant(b.getAttribute('data-q'), true); });
    });

    // Hint under the receptor table when the query is clearly not a receptor.
    var rInput = document.getElementById('search-input');
    var hint = document.getElementById('receptor-search-hint');
    if (rInput && hint) {
      rInput.addEventListener('input', function () {
        var q = rInput.value.trim();
        var c = classify(q);
        if (q && isOtherKind(c)) {
          hint.innerHTML = 'Looking for a variant or a generic position? <button type="button">Search variants and positions for <code>' +
            esc(q) + '</code></button>';
          hint.hidden = false;
          hint.querySelector('button').addEventListener('click', function () {
            selectTab('variants');
            submitVariant(q, true);
          });
        } else {
          hint.hidden = true;
          hint.innerHTML = '';
        }
      });
    }

    // Arrival from the topbar (?q=) or a shared link (?mode=variants&q=).
    var params = new URLSearchParams(window.location.search);
    if (!params.has('q') && !params.has('mode')) return;
    var q = (params.get('q') || '').trim();
    var c = classify(q);
    if (params.get('mode') === 'variants' || isOtherKind(c)) {
      selectTab('variants');
      if (q) submitVariant(q, false);
      else document.getElementById('vsearch-input').focus();
    } else if (rInput) {
      rInput.value = q;
      rInput.dispatchEvent(new Event('input', { bubbles: true }));
      rInput.focus();
    }
  }

  window.SiteSearch = { init: init, classify: classify };
})();
