/* Dibujo de textos superpuestos. Se usa para la vista previa y para generar los
   PNG que se superponen al exportar, de modo que ambos coinciden. */
(function () {
  const App = window.App;
  const X = (App.text = {});

  function font(t, px) {
    return `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${px}px "${t.font}", "Segoe UI", sans-serif`;
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // Medidas del bloque de texto en un lienzo de W×H.
  X.measure = function (ctx, t, W, H) {
    const px = Math.max(4, (t.size / 100) * H);
    ctx.font = font(t, px);
    const lines = String(t.text || '').split('\n');
    const lineH = px * 1.22;
    const widths = lines.map((l) => ctx.measureText(l).width);
    const w = Math.max(1, ...widths), hgt = lines.length * lineH;
    const pad = t.box ? px * 0.38 : 0;
    const cx = t.x * W, cy = t.y * H;
    return { px, lines, lineH, widths, w, h: hgt, pad, x: cx - w / 2 - pad, y: cy - hgt / 2 - pad, bw: w + pad * 2, bh: hgt + pad * 2, cx, cy };
  };

  X.draw = function (ctx, t, W, H, alpha = 1) {
    if (!t.text || alpha <= 0) return;
    const m = X.measure(ctx, t, W, H);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (t.box) {
      ctx.fillStyle = hexA(t.boxColor, t.boxOpacity / 100);
      const r = m.px * 0.28;
      ctx.beginPath();
      ctx.roundRect(m.x, m.y, m.bw, m.bh, r);
      ctx.fill();
    }
    ctx.font = font(t, m.px);
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const left = m.cx - m.w / 2;
    m.lines.forEach((line, i) => {
      const y = m.cy - m.h / 2 + m.lineH * (i + 0.5);
      let x, align;
      if (t.align === 'left') { x = left; align = 'left'; }
      else if (t.align === 'right') { x = left + m.w; align = 'right'; }
      else { x = m.cx; align = 'center'; }
      ctx.textAlign = align;
      if (t.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,.65)';
        ctx.shadowBlur = m.px * 0.18;
        ctx.shadowOffsetY = m.px * 0.05;
      }
      if (t.outline > 0) {
        ctx.lineWidth = (t.outline / 100) * m.px * 0.5;
        ctx.strokeStyle = t.outlineColor;
        ctx.strokeText(line, x, y);
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = t.color;
      ctx.fillText(line, x, y);
      ctx.shadowColor = 'transparent';
    });
    ctx.restore();
  };

  // Opacidad del texto en el instante t (fundidos de entrada y salida).
  X.alphaAt = function (t, time) {
    const local = time - t.start;
    if (local < 0 || local >= t.duration) return 0;
    let a = 1;
    if (t.fadeIn > 0) a = Math.min(a, local / t.fadeIn);
    if (t.fadeOut > 0) a = Math.min(a, (t.duration - local) / t.fadeOut);
    return clamp(a, 0, 1);
  };

  X.renderPng = async function (t, W, H) {
    const c = new OffscreenCanvas(W, H);
    X.draw(c.getContext('2d'), t, W, H, 1);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  };
})();
