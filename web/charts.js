/*
 * Smart Mess - tiny SVG chart builders for the manager dashboard (Member 4).
 *
 * Pure functions that return an HTML string (legend + <svg>). No DOM, no dependencies,
 * so they are unit tested in Node. Colours come from CSS classes in web/dashboard.css
 * (theme aware). Series are also told apart by line style, not colour alone.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SmartMessCharts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 640, H = 260, ML = 52, MR = 12, MT = 12, MB = 36;

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function r1(n) { return Math.round(n * 10) / 10; }

  /** Smallest "nice" step (1, 2, 5 x 10^k) that is >= v. */
  function niceStep(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  function axis(maxValue) {
    var step = niceStep(maxValue / 4);
    return { step: step, top: step * 4 };
  }

  function legend(series) {
    return '<div class="legend">' + series.map(function (s) {
      return '<span><i class="sw ' + esc(s.cls) + '"></i>' + esc(s.label) + '</span>';
    }).join('') + '</div>';
  }

  function frame(ax, labels, xAt) {
    var out = '', plotH = H - MT - MB, i;
    for (i = 0; i <= 4; i++) {
      var y = MT + plotH - (i / 4) * plotH;
      out += '<line class="grid" x1="' + ML + '" x2="' + (W - MR) + '" y1="' + r1(y) + '" y2="' + r1(y) + '"/>' +
        '<text x="' + (ML - 6) + '" y="' + r1(y + 4) + '" text-anchor="end">' + esc(Math.round(ax.step * i)) + '</text>';
    }
    var every = Math.max(1, Math.ceil(labels.length / 8));
    labels.forEach(function (l, k) {
      if (k % every !== 0 && k !== labels.length - 1) return;
      out += '<text x="' + r1(xAt(k)) + '" y="' + (H - 12) + '" text-anchor="middle">' + esc(l) + '</text>';
    });
    return out;
  }

  /**
   * opts: { points:[{label, values:{key:number}}], series:[{key,label,cls}], aria }
   * One polyline per series plus a dot (with a hover title) per value.
   */
  function lineChart(opts) {
    var pts = opts.points || [], series = opts.series || [];
    if (!pts.length) return '';
    var max = 0;
    pts.forEach(function (p) { series.forEach(function (s) { if (typeof p.values[s.key] === 'number') max = Math.max(max, p.values[s.key]); }); });
    var ax = axis(max), plotW = W - ML - MR, plotH = H - MT - MB;
    var xAt = function (i) { return pts.length === 1 ? ML + plotW / 2 : ML + (i / (pts.length - 1)) * plotW; };
    var yAt = function (v) { return MT + plotH - (v / ax.top) * plotH; };
    var body = frame(ax, pts.map(function (p) { return p.label; }), xAt);
    series.forEach(function (s) {
      var d = '', dots = '';
      pts.forEach(function (p, i) {
        var v = p.values[s.key];
        if (typeof v !== 'number') return;
        d += (d ? 'L' : 'M') + r1(xAt(i)) + ',' + r1(yAt(v));
        dots += '<circle class="dot ' + esc(s.cls) + '" cx="' + r1(xAt(i)) + '" cy="' + r1(yAt(v)) + '" r="3.5"><title>' + esc(p.label + ' - ' + s.label + ': ' + v) + '</title></circle>';
      });
      body += '<path class="ln ' + esc(s.cls) + '" d="' + d + '"/>' + dots;
    });
    return legend(series) + '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.aria || 'Line chart') + '">' + body + '</svg>';
  }

  /** Grouped bars, same input shape as lineChart. */
  function barChart(opts) {
    var pts = opts.points || [], series = opts.series || [];
    if (!pts.length) return '';
    var max = 0;
    pts.forEach(function (p) { series.forEach(function (s) { if (typeof p.values[s.key] === 'number') max = Math.max(max, p.values[s.key]); }); });
    var ax = axis(max), plotW = W - ML - MR, plotH = H - MT - MB;
    var slot = plotW / pts.length, gap = Math.min(10, slot * 0.2), bw = Math.max(2, (slot - gap) / series.length);
    var xAt = function (i) { return ML + slot * i + slot / 2; };
    var body = frame(ax, pts.map(function (p) { return p.label; }), xAt);
    pts.forEach(function (p, i) {
      series.forEach(function (s, j) {
        var v = p.values[s.key];
        if (typeof v !== 'number') return;
        var h = (v / ax.top) * plotH, x = ML + slot * i + gap / 2 + bw * j;
        body += '<rect class="bar-' + esc(s.cls) + '" x="' + r1(x) + '" y="' + r1(MT + plotH - h) + '" width="' + r1(bw) + '" height="' + r1(h) + '"><title>' + esc(p.label + ' - ' + s.label + ': ' + v) + '</title></rect>';
      });
    });
    return legend(series) + '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.aria || 'Bar chart') + '">' + body + '</svg>';
  }

  return { lineChart: lineChart, barChart: barChart, niceStep: niceStep, axis: axis };
});
