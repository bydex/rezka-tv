/* Remote-control navigation, screen stack and small widgets */
var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, ESC: 27, BACKSPACE: 8,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412,
    CHUP: 427, CHDOWN: 428,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    IME_DONE: 65376, IME_CANCEL: 65385
};

function h(tag, cls, html) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html !== undefined) el.innerHTML = html;
    return el;
}

function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var hh = Math.floor(sec / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60;
    return (hh ? hh + ':' + (mm < 10 ? '0' : '') : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
}

/* Spatial navigation over elements with class "focusable" inside the current root */
var Nav = (function () {
    'use strict';
    var root = document.body;
    var cur = null;

    function isVisible(el) {
        if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function items() {
        return Array.prototype.filter.call(root.querySelectorAll('.focusable'), function (el) {
            return !el.classList.contains('disabled') && isVisible(el);
        });
    }

    function offsetWithin(el, container, prop) {
        var v = 0;
        while (el && el !== container) {
            v += el[prop];
            el = el.offsetParent;
        }
        return v;
    }

    // Scroll containers are marked .scroll-y / .scroll-x and must be position: relative
    function ensureVisible(el) {
        var p = el.parentElement;
        while (p && p !== document.body) {
            var margin = parseInt(p.getAttribute('data-margin') || '60', 10);
            if (p.classList.contains('scroll-y')) {
                var top = offsetWithin(el, p, 'offsetTop');
                if (p.hasAttribute('data-center')) {
                    p.scrollTop = Math.max(0, top - (p.clientHeight - el.offsetHeight) / 2);
                } else if (top - margin < p.scrollTop) {
                    p.scrollTop = Math.max(0, top - margin);
                } else if (top + el.offsetHeight + margin > p.scrollTop + p.clientHeight) {
                    p.scrollTop = top + el.offsetHeight + margin - p.clientHeight;
                }
            }
            if (p.classList.contains('scroll-x')) {
                var left = offsetWithin(el, p, 'offsetLeft');
                if (left - margin < p.scrollLeft) {
                    p.scrollLeft = Math.max(0, left - margin);
                } else if (left + el.offsetWidth + margin > p.scrollLeft + p.clientWidth) {
                    p.scrollLeft = left + el.offsetWidth + margin - p.clientWidth;
                }
            }
            p = p.parentElement;
        }
    }

    function focus(el) {
        if (!el) return;
        if (cur && cur !== el) cur.classList.remove('focused');
        cur = el;
        el.classList.add('focused');
        var group = el.closest('[data-group]');
        if (group) group._last = el;
        ensureVisible(el);
        if (el.onfocused) el.onfocused();
    }

    function first() {
        var list = items();
        var pref = list.filter(function (e) { return e.classList.contains('default-focus'); })[0];
        return pref || list[0];
    }

    function move(dir) {
        var list = items();
        if (!cur || list.indexOf(cur) < 0) { focus(first()); return !!cur; }
        var a = cur.getBoundingClientRect();
        var acx = a.left + a.width / 2, acy = a.top + a.height / 2;
        var best = null, bestScore = Infinity;
        list.forEach(function (el) {
            if (el === cur) return;
            var b = el.getBoundingClientRect();
            var bcx = b.left + b.width / 2, bcy = b.top + b.height / 2;
            var main, cross, align;
            if (dir === 'left' || dir === 'right') {
                if (dir === 'right' ? bcx <= acx + 1 : bcx >= acx - 1) return;
                main = dir === 'right' ? b.left - a.right : a.left - b.right;
                cross = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
                align = Math.abs(bcy - acy);
            } else {
                if (dir === 'down' ? bcy <= acy + 1 : bcy >= acy - 1) return;
                main = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
                cross = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
                align = Math.abs(bcx - acx);
            }
            var score = Math.max(0, main) + cross * 4 + align * 0.05;
            if (score < bestScore) { bestScore = score; best = el; }
        });
        if (!best) return false;
        // Entering another group returns to the element last focused there
        var fromGroup = cur.closest('[data-group]');
        var toGroup = best.closest('[data-group]');
        if (toGroup && toGroup !== fromGroup && toGroup._last && toGroup.contains(toGroup._last) &&
            list.indexOf(toGroup._last) >= 0 && !toGroup.hasAttribute('data-nomemory')) {
            best = toGroup._last;
        }
        focus(best);
        return true;
    }

    function activate() {
        if (!cur || !root.contains(cur)) return;
        if (cur.tagName === 'INPUT') {
            cur.focus();
            return;
        }
        cur.click();
    }

    return {
        setRoot: function (el) { root = el; },
        getRoot: function () { return root; },
        current: function () { return cur && root.contains(cur) ? cur : null; },
        focus: focus,
        first: first,
        move: move,
        activate: activate,
        ensureVisible: ensureVisible
    };
})();

/* Stack of full-screen views; the top one receives keys */
var Screens = (function () {
    'use strict';
    var stack = [];
    var app = document.getElementById('app');

    function top() { return stack[stack.length - 1]; }

    function show(s) {
        Nav.setRoot(s.el);
        s.el.classList.remove('hidden');
        if (s.onShow) s.onShow();
        var target = s.saved && s.el.contains(s.saved) ? s.saved : null;
        Nav.focus(target || (s.initialFocus && s.initialFocus()) || Nav.first());
    }

    function push(s) {
        var prev = top();
        if (prev) {
            prev.saved = Nav.current();
            if (!s.overlay) prev.el.classList.add('hidden');
        }
        stack.push(s);
        app.appendChild(s.el);
        show(s);
    }

    function pop() {
        var s = stack.pop();
        if (!s) return;
        if (s.onClose) s.onClose();
        if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
        if (top()) show(top());
    }

    function replaceAll(s) {
        while (stack.length) {
            var x = stack.pop();
            if (x.onClose) x.onClose();
            if (x.el.parentNode) x.el.parentNode.removeChild(x.el);
        }
        push(s);
    }

    function back() {
        var s = top();
        if (s && s.onBack && s.onBack() === true) return;
        if (stack.length > 1) pop();
        else exitApp();
    }

    return { push: push, pop: pop, top: top, back: back, replaceAll: replaceAll, size: function () { return stack.length; } };
})();

function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* not on a TV */ }
}

var Toast = (function () {
    var el = document.getElementById('toast');
    var timer = null;
    return function (msg, ms) {
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(timer);
        timer = setTimeout(function () { el.classList.remove('show'); }, ms || 3500);
    };
})();

var Loader = (function () {
    var el = document.getElementById('loader');
    var count = 0;
    return {
        show: function () { count++; el.classList.remove('hidden'); },
        hide: function () { count = Math.max(0, count - 1); if (!count) el.classList.add('hidden'); },
        wrap: function (promise) {
            Loader.show();
            return promise.then(function (v) { Loader.hide(); return v; }, function (e) { Loader.hide(); throw e; });
        }
    };
})();

/* Modal list picker. options: [{label, sub, active, premium}] */
function showSelect(title, options, onSelect) {
    var s = { el: h('div', 'screen modal'), overlay: true };
    var box = h('div', 'modal-box');
    box.appendChild(h('div', 'modal-title', esc(title)));
    var list = h('div', 'modal-list scroll-y');
    list.setAttribute('data-center', '');
    var activeEl = null;
    options.forEach(function (o, i) {
        var item = h('div', 'modal-item focusable' + (o.active ? ' active' : ''),
            '<span>' + esc(o.label) + (o.premium ? ' <i class="prem">Premium</i>' : '') + '</span>' +
            (o.sub ? '<small>' + esc(o.sub) + '</small>' : ''));
        item.onclick = function () {
            Screens.pop();
            onSelect(o, i);
        };
        if (o.active) activeEl = item;
        list.appendChild(item);
    });
    box.appendChild(list);
    s.el.appendChild(box);
    s.initialFocus = function () { return activeEl; };
    Screens.push(s);
}

/* Text input that opens the TV on-screen keyboard on OK */
function makeInput(placeholder, type, onDone) {
    var input = h('input', 'input focusable');
    input.type = type || 'text';
    input.placeholder = placeholder;
    input.setAttribute('autocomplete', 'off');
    input.addEventListener('keydown', function (e) {
        var k = e.keyCode;
        if (k === KEY.ENTER || k === KEY.IME_DONE) {
            e.preventDefault();
            e.stopPropagation();
            input.blur();
            if (onDone) onDone(input.value);
        } else if (k === KEY.IME_CANCEL || k === KEY.BACK || k === KEY.ESC) {
            e.preventDefault();
            e.stopPropagation();
            input.blur();
        } else if (k === KEY.UP || k === KEY.DOWN) {
            // leave the field with arrows like any other control
            e.preventDefault();
            input.blur();
        } else {
            e.stopPropagation();
        }
    });
    return input;
}
