(function () {
  'use strict';

  var wrap;
  var canvas;
  var ctx;
  var status;
  var reader;
  var readerMeta;
  var readerTitle;
  var readerBody;
  var readerClose;
  var a11y;
  var drawer;
  var panel;
  var resizeObserver;
  var visibilityObserver;
  var nodes = [];
  var edges = [];
  var hubEdges = [];
  var nodeById = new Map();
  var data = { categories: [], notes: [], journal: { entries: [] } };
  var camera = { x: 0, y: 0, scale: 1 };
  var cameraTarget = null;
  var alpha = 0;
  var frame = 0;
  var active = false;
  var hovered = null;
  var selected = null;
  var pointer = null;
  var width = 0;
  var height = 0;
  var dpr = 1;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function hash(value) {
    var h = 2166136261;
    for (var i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function hueFor(slug) {
    return hash(slug) % 360;
  }

  function nodeColor(slug, lightness) {
    return 'hsl(' + hueFor(slug) + ' 72% ' + lightness + '%)';
  }

  function init() {
    wrap = document.getElementById('memoryGraphWrap');
    canvas = document.getElementById('memoryGraph');
    status = document.getElementById('memoryGraphStatus');
    reader = document.getElementById('memoryReader');
    readerMeta = document.getElementById('memoryReaderMeta');
    readerTitle = document.getElementById('memoryReaderTitle');
    readerBody = document.getElementById('memoryReaderBody');
    readerClose = document.getElementById('memoryReaderClose');
    a11y = document.getElementById('memoryA11y');
    drawer = document.getElementById('settingsDrawer');
    panel = document.querySelector('.settings-panel[data-panel="memory"]');
    if (!wrap || !canvas) return false;
    ctx = canvas.getContext('2d');
    if (!ctx) return false;

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    if (readerClose) readerClose.addEventListener('click', resetView);
    document.addEventListener('visibilitychange', syncAnimation);
    window.addEventListener('keydown', onKeyDown, true);

    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(wrap);
    visibilityObserver = new MutationObserver(syncAnimation);
    if (drawer) visibilityObserver.observe(drawer, { attributes: true, attributeFilter: ['class'] });
    if (panel) visibilityObserver.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    resize();
    return true;
  }

  function isRunnable() {
    return active
      && !document.hidden
      && (!drawer || drawer.classList.contains('open'))
      && (!panel || !panel.hidden)
      && width > 0
      && height > 0;
  }

  function syncAnimation() {
    resize();
    if (!isRunnable()) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      return;
    }
    if (alpha >= 0.005 || cameraTarget) ensureFrame();
    else draw();
  }

  function resize() {
    if (!wrap || !canvas) return;
    var nextWidth = wrap.clientWidth;
    var nextHeight = wrap.clientHeight;
    if (nextWidth <= 0 || nextHeight <= 0) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    if (nextWidth === width && nextHeight === height
        && canvas.width === Math.round(width * dpr)
        && canvas.height === Math.round(height * dpr)) return;
    width = nextWidth;
    height = nextHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    draw();
  }

  function setStatus(message) {
    if (!initReady() || !status) return;
    status.textContent = message || '';
    status.hidden = !message;
  }

  function initReady() {
    return canvas ? true : init();
  }

  function setActive(value) {
    if (!initReady()) return;
    active = !!value;
    syncAnimation();
  }

  function initialPosition(id, index, total) {
    var angle = ((hash(id) % 6283) / 1000) + (index / Math.max(1, total)) * Math.PI * 2;
    var radius = 90 + (hash(id + ':radius') % 150);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }

  function setData(nextData) {
    if (!initReady()) return;
    data = nextData && typeof nextData === 'object' ? nextData : data;
    var oldPositions = new Map(nodes.map(function (node) {
      return [node.id, { x: node.x, y: node.y, vx: node.vx, vy: node.vy }];
    }));
    var categories = Array.isArray(data.categories) ? data.categories : [];
    var notes = Array.isArray(data.notes) ? data.notes : [];
    var journalEntries = data.journal && Array.isArray(data.journal.entries) ? data.journal.entries : [];
    var categorySlugs = new Set(categories.map(function (category) { return category.slug; }));
    notes.forEach(function (note) { categorySlugs.add(note.category || 'general'); });

    nodes = [];
    edges = [];
    hubEdges = [];
    nodeById = new Map();
    var hubs = new Map();
    var slugs = Array.from(categorySlugs).sort();
    slugs.push('journal');
    slugs.forEach(function (slug, index) {
      var id = 'hub:' + slug;
      var position = oldPositions.get(id) || initialPosition(id, index, slugs.length);
      var hub = {
        id: id,
        type: slug === 'journal' ? 'journal-hub' : 'hub',
        category: slug,
        label: slug === 'journal' ? 'journal' : slug,
        r: 9,
        color: nodeColor(slug, 62),
        x: position.x,
        y: position.y,
        vx: position.vx || 0,
        vy: position.vy || 0,
        fx: 0,
        fy: 0,
      };
      nodes.push(hub);
      nodeById.set(id, hub);
      hubs.set(slug, hub);
    });

    notes.forEach(function (note, index) {
      var category = note.category || 'general';
      var hub = hubs.get(category);
      if (!hub) return;
      var id = 'note:' + note.id;
      var position = oldPositions.get(id) || {
        x: hub.x + Math.cos((hash(id) % 6283) / 1000) * (45 + hash(id + ':r') % 50),
        y: hub.y + Math.sin((hash(id) % 6283) / 1000) * (45 + hash(id + ':r') % 50),
      };
      var node = {
        id: id,
        noteId: note.id,
        type: 'leaf',
        category: category,
        text: note.text || '',
        created: Number(note.created) || 0,
        links: Array.isArray(note.links) ? note.links : [],
        label: note.text || 'Memory ' + (index + 1),
        r: 3.5,
        color: nodeColor(category, 70),
        x: position.x,
        y: position.y,
        vx: position.vx || 0,
        vy: position.vy || 0,
        fx: 0,
        fy: 0,
      };
      nodes.push(node);
      nodeById.set(id, node);
      edges.push({ from: node, to: hub, type: 'spring' });
    });

    var journalHub = hubs.get('journal');
    journalEntries.forEach(function (entry, index) {
      var id = 'journal:' + entry.date;
      var position = oldPositions.get(id) || {
        x: journalHub.x + Math.cos((hash(id) % 6283) / 1000) * (45 + hash(id + ':r') % 50),
        y: journalHub.y + Math.sin((hash(id) % 6283) / 1000) * (45 + hash(id + ':r') % 50),
      };
      var node = {
        id: id,
        type: 'journal-leaf',
        category: 'journal',
        date: entry.date,
        text: entry.text || '',
        label: entry.date,
        r: 3.5,
        color: nodeColor('journal', 70),
        x: position.x,
        y: position.y,
        vx: position.vx || 0,
        vy: position.vy || 0,
        fx: 0,
        fy: 0,
      };
      nodes.push(node);
      nodeById.set(id, node);
      edges.push({ from: node, to: journalHub, type: 'spring' });
    });

    nodes.forEach(function (node) {
      if (node.type !== 'leaf') return;
      node.links.forEach(function (slug) {
        var linkedHub = hubs.get(slug);
        if (!linkedHub || linkedHub.category === node.category) return;
        edges.push({ from: node, to: linkedHub, type: 'cross' });
        var sourceHub = hubs.get(node.category);
        var key = [sourceHub.id, linkedHub.id].sort().join('|');
        if (!hubEdges.some(function (edge) { return edge.key === key; })) {
          hubEdges.push({ key: key, from: sourceHub, to: linkedHub });
        }
      });
    });

    selected = selected && nodeById.get(selected.id) || null;
    if (selected) openReader(selected);
    else if (reader) reader.hidden = true;
    hovered = null;
    alpha = 1;
    updateA11y(slugs, notes, journalEntries);
    var contentCount = notes.length + journalEntries.length;
    setStatus(contentCount ? '' : 'No memories yet. Ask Jun to remember something, or add one below.');
    if (reducedMotion) {
      for (var i = 0; i < 300; i++) physicsStep();
      alpha = 0;
      draw();
    } else {
      ensureFrame();
    }
  }

  function updateA11y(slugs, notes, journalEntries) {
    if (!a11y) return;
    a11y.replaceChildren();
    slugs.filter(function (slug) { return slug !== 'journal'; }).forEach(function (slug) {
      var item = document.createElement('li');
      item.textContent = slug;
      var list = document.createElement('ul');
      notes.filter(function (note) { return (note.category || 'general') === slug; }).forEach(function (note) {
        var noteItem = document.createElement('li');
        noteItem.textContent = note.text || '';
        list.appendChild(noteItem);
      });
      item.appendChild(list);
      a11y.appendChild(item);
    });
    var journalItem = document.createElement('li');
    journalItem.textContent = 'Journal';
    var journalList = document.createElement('ul');
    journalEntries.forEach(function (entry) {
      var entryItem = document.createElement('li');
      entryItem.textContent = entry.date + ': ' + entry.text;
      journalList.appendChild(entryItem);
    });
    journalItem.appendChild(journalList);
    a11y.appendChild(journalItem);
  }

  function applySpring(a, b, rest, strength) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var distance = Math.max(0.1, Math.hypot(dx, dy));
    var force = (distance - rest) * strength;
    var fx = dx / distance * force;
    var fy = dy / distance * force;
    a.fx += fx;
    a.fy += fy;
    b.fx -= fx;
    b.fy -= fy;
  }

  function physicsStep() {
    if (!nodes.length || alpha < 0.005) return;
    nodes.forEach(function (node) { node.fx = -node.x * 0.002; node.fy = -node.y * 0.002; });
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var a = nodes[i];
        var b = nodes[j];
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var distanceSq = Math.max(36, dx * dx + dy * dy);
        var distance = Math.sqrt(distanceSq);
        var hubBoost = a.r > 5 && b.r > 5 ? 5 : (a.r > 5 || b.r > 5 ? 1.8 : 1);
        var force = 680 * hubBoost / distanceSq;
        var fx = dx / distance * force;
        var fy = dy / distance * force;
        a.fx -= fx;
        a.fy -= fy;
        b.fx += fx;
        b.fy += fy;
      }
    }
    edges.forEach(function (edge) {
      if (edge.type === 'spring') applySpring(edge.from, edge.to, 60, 0.02);
    });
    hubEdges.forEach(function (edge) { applySpring(edge.from, edge.to, 220, 0.005); });
    nodes.forEach(function (node) {
      node.vx = (node.vx + node.fx * alpha) * 0.85;
      node.vy = (node.vy + node.fy * alpha) * 0.85;
      node.x += node.vx;
      node.y += node.vy;
    });
    alpha *= 0.985;
  }

  function ensureFrame() {
    if (!frame && isRunnable() && !reducedMotion) frame = requestAnimationFrame(tick);
  }

  function tick() {
    frame = 0;
    if (!isRunnable()) return;
    if (alpha >= 0.005) physicsStep();
    if (cameraTarget) {
      camera.x += (cameraTarget.x - camera.x) * 0.14;
      camera.y += (cameraTarget.y - camera.y) * 0.14;
      camera.scale += (cameraTarget.scale - camera.scale) * 0.14;
      if (Math.abs(cameraTarget.x - camera.x) < 0.05
          && Math.abs(cameraTarget.y - camera.y) < 0.05
          && Math.abs(cameraTarget.scale - camera.scale) < 0.002) {
        camera.x = cameraTarget.x;
        camera.y = cameraTarget.y;
        camera.scale = cameraTarget.scale;
        cameraTarget = null;
      }
    }
    draw();
    if (alpha >= 0.005 || cameraTarget) ensureFrame();
  }

  function draw() {
    if (!ctx || !width || !height) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-camera.x, -camera.y);

    edges.forEach(function (edge) {
      ctx.beginPath();
      ctx.moveTo(edge.from.x, edge.from.y);
      ctx.lineTo(edge.to.x, edge.to.y);
      ctx.strokeStyle = edge.type === 'cross' ? 'rgba(218, 224, 244, .14)' : 'rgba(218, 224, 244, .2)';
      ctx.lineWidth = (edge.type === 'cross' ? 0.55 : 0.75) / camera.scale;
      ctx.stroke();
    });

    nodes.forEach(function (node) {
      if (selected === node || hovered === node) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.r + 4 / camera.scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,.8)';
        ctx.lineWidth = 1.2 / camera.scale;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.shadowColor = node.color;
      ctx.shadowBlur = node.r > 5 ? 12 : 7;
      ctx.fill();
      ctx.shadowBlur = 0;
      if (node.r > 5) {
        ctx.font = (11 / camera.scale) + 'px ui-monospace, monospace';
        ctx.fillStyle = 'rgba(238,241,250,.88)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(node.label, node.x, node.y + node.r + 5 / camera.scale);
      }
    });
    ctx.restore();
    if (hovered && hovered.r <= 5) drawTooltip(hovered);
  }

  function worldToScreen(node) {
    return {
      x: width / 2 + (node.x - camera.x) * camera.scale,
      y: height / 2 + (node.y - camera.y) * camera.scale,
    };
  }

  function screenToWorld(x, y) {
    return {
      x: camera.x + (x - width / 2) / camera.scale,
      y: camera.y + (y - height / 2) / camera.scale,
    };
  }

  function drawTooltip(node) {
    var point = worldToScreen(node);
    var label = node.label.length > 72 ? node.label.slice(0, 69) + '…' : node.label;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '12px system-ui, sans-serif';
    var textWidth = Math.min(width - 24, ctx.measureText(label).width + 18);
    var x = Math.max(8, Math.min(width - textWidth - 8, point.x + 10));
    var y = Math.max(8, Math.min(height - 34, point.y - 30));
    ctx.fillStyle = 'rgba(16, 19, 28, .94)';
    ctx.strokeStyle = 'rgba(255,255,255,.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x, y, textWidth, 26);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#eef1fa';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 9, y + 13, textWidth - 18);
  }

  function canvasPoint(event) {
    var rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hitTest(point) {
    var world = screenToWorld(point.x, point.y);
    var hit = null;
    var best = Infinity;
    nodes.forEach(function (node) {
      var distance = Math.hypot(node.x - world.x, node.y - world.y);
      var radius = node.r + 7 / camera.scale;
      if (distance <= radius && distance < best) {
        hit = node;
        best = distance;
      }
    });
    return hit;
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    var point = canvasPoint(event);
    pointer = {
      id: event.pointerId,
      startX: point.x,
      startY: point.y,
      cameraX: camera.x,
      cameraY: camera.y,
      moved: false,
      node: hitTest(point),
    };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');
  }

  function onPointerMove(event) {
    var point = canvasPoint(event);
    if (pointer && pointer.id === event.pointerId) {
      var dx = point.x - pointer.startX;
      var dy = point.y - pointer.startY;
      if (Math.hypot(dx, dy) > 4) pointer.moved = true;
      if (pointer.moved) {
        cameraTarget = null;
        camera.x = pointer.cameraX - dx / camera.scale;
        camera.y = pointer.cameraY - dy / camera.scale;
        draw();
      }
      return;
    }
    var next = hitTest(point);
    if (next !== hovered) {
      hovered = next;
      canvas.style.cursor = hovered ? 'pointer' : 'grab';
      draw();
    }
  }

  function onPointerLeave() {
    if (pointer || !hovered) return;
    hovered = null;
    canvas.style.cursor = 'grab';
    draw();
  }

  function onPointerUp(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    var point = canvasPoint(event);
    if (!pointer.moved) {
      var node = hitTest(point);
      if (node) focusNode(node);
      else resetView();
    }
    canvas.classList.remove('dragging');
    canvas.releasePointerCapture(event.pointerId);
    pointer = null;
  }

  function onPointerCancel(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    canvas.classList.remove('dragging');
    pointer = null;
  }

  function onWheel(event) {
    event.preventDefault();
    cameraTarget = null;
    var point = canvasPoint(event);
    var before = screenToWorld(point.x, point.y);
    var nextScale = Math.max(0.35, Math.min(4, camera.scale * Math.exp(-event.deltaY * 0.0012)));
    camera.scale = nextScale;
    camera.x = before.x - (point.x - width / 2) / nextScale;
    camera.y = before.y - (point.y - height / 2) / nextScale;
    draw();
  }

  function focusNode(node) {
    selected = node;
    cameraTarget = { x: node.x, y: node.y, scale: 2.2 };
    openReader(node);
    if (reducedMotion) {
      camera.x = node.x;
      camera.y = node.y;
      camera.scale = 2.2;
      cameraTarget = null;
      draw();
      return;
    }
    ensureFrame();
  }

  function resetView() {
    selected = null;
    hovered = null;
    if (reader) reader.hidden = true;
    cameraTarget = { x: 0, y: 0, scale: 1 };
    ensureFrame();
    if (reducedMotion) {
      camera.x = 0;
      camera.y = 0;
      camera.scale = 1;
      cameraTarget = null;
      draw();
    }
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || !isRunnable() || (!selected && (!reader || reader.hidden))) return;
    event.preventDefault();
    event.stopPropagation();
    resetView();
  }

  function formatDate(timestamp) {
    return timestamp ? new Date(timestamp * 1000).toLocaleDateString() : 'Date unknown';
  }

  function appendMemoryList(items, emptyText) {
    readerBody.replaceChildren();
    if (!items.length) {
      readerBody.textContent = emptyText;
      return;
    }
    var list = document.createElement('ul');
    items.forEach(function (text) {
      var item = document.createElement('li');
      item.textContent = text;
      list.appendChild(item);
    });
    readerBody.appendChild(list);
  }

  function openReader(node) {
    if (!reader || !readerMeta || !readerTitle || !readerBody) return;
    reader.hidden = false;
    if (node.type === 'leaf') {
      readerMeta.textContent = node.category + ' · ' + formatDate(node.created);
      readerTitle.textContent = 'Saved memory';
      readerBody.replaceChildren();
      var text = document.createElement('p');
      text.textContent = node.text;
      readerBody.appendChild(text);
      return;
    }
    if (node.type === 'journal-leaf') {
      readerMeta.textContent = 'journal';
      readerTitle.textContent = node.date;
      readerBody.replaceChildren();
      var entry = document.createElement('p');
      entry.textContent = node.text;
      readerBody.appendChild(entry);
      return;
    }
    if (node.type === 'journal-hub') {
      readerMeta.textContent = 'journal';
      readerTitle.textContent = 'Jun’s journal';
      appendMemoryList(
        (data.journal && Array.isArray(data.journal.entries) ? data.journal.entries : []).map(function (entry) {
          return entry.date + ': ' + entry.text;
        }),
        'The journal is empty.'
      );
      return;
    }
    readerMeta.textContent = node.category;
    readerTitle.textContent = node.label;
    appendMemoryList(
      (Array.isArray(data.notes) ? data.notes : [])
        .filter(function (note) { return (note.category || 'general') === node.category; })
        .map(function (note) { return note.text || ''; }),
      'No notes in this category.'
    );
  }

  window.MemoryGraph = {
    setData: setData,
    setStatus: setStatus,
    setActive: setActive,
    reset: resetView,
  };
})();
