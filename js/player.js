/* Full-screen video player with remote-control OSD */
var Player = (function () {
    'use strict';

    var QUALITY_ORDER = ['360p', '480p', '720p', '1080p', '1080p Ultra', '2K', '4K'];

    function screensaver(on) {
        try {
            var st = webapis.appcommon.AppCommonScreenSaverState;
            webapis.appcommon.setScreenSaver(on ? st.SCREEN_SAVER_ON : st.SCREEN_SAVER_OFF);
        } catch (e) { /* not on a TV */ }
    }

    function posKey(id, season, episode) {
        return 'rz.pos.' + id + '.' + (season || 0) + '.' + (episode || 0);
    }

    function loadPos(id, season, episode) {
        try { return JSON.parse(Api.store(posKey(id, season, episode)) || 'null'); } catch (e) { return null; }
    }

    function savePos(id, season, episode, t, d) {
        Api.store(posKey(id, season, episode), JSON.stringify({ t: Math.floor(t), d: Math.floor(d), ts: Date.now() }));
    }

    function parseVtt(src) {
        var cues = [];
        src.replace(/\r/g, '').split(/\n{2,}/).forEach(function (block) {
            var m = block.match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)\s*-->\s*(?:(\d+):)?(\d+):(\d+)[.,](\d+)[^\n]*\n([\s\S]*)/);
            if (!m) return;
            var t = function (hh, mm, ss, ms) {
                return (parseInt(hh || '0', 10) * 3600) + parseInt(mm, 10) * 60 + parseInt(ss, 10) + parseInt(ms, 10) / 1000;
            };
            cues.push({ s: t(m[1], m[2], m[3], m[4]), e: t(m[5], m[6], m[7], m[8]), text: m[9].replace(/<[^>]+>/g, '').trim() });
        });
        return cues;
    }

    function preferredQuality(list) {
        var allowed = list.filter(function (q) { return !q.premium || Api.session.premium; });
        if (!allowed.length) allowed = list;
        var pref = Api.store('rz.quality') || 'max';
        if (pref === 'max') return list.indexOf(allowed[allowed.length - 1]);
        var want = QUALITY_ORDER.indexOf(pref), best = allowed[0];
        allowed.forEach(function (q) {
            var rank = QUALITY_ORDER.indexOf(q.name);
            if (rank >= 0 && rank <= want) best = q;
        });
        return list.indexOf(best);
    }

    /* ctx: { details, translatorId, season, episode, onExit } */
    function open(ctx) {
        var d = ctx.details;
        var s = { el: h('div', 'screen player') };
        s.el.innerHTML =
            '<video preload="auto"></video>' +
            '<div class="subs"></div>' +
            '<div class="p-spinner hidden"><div class="spin"></div></div>' +
            '<div class="p-seekhint hidden"></div>' +
            '<div class="osd">' +
            '  <div class="osd-top"><div class="p-title"></div><div class="p-sub"></div></div>' +
            '  <div class="osd-bottom">' +
            '    <div class="p-bar focusable default-focus" data-group="bar"><div class="p-buf"></div><div class="p-prog"></div><div class="p-knob"></div><div class="p-seek"></div></div>' +
            '    <div class="p-times"><span class="p-cur">0:00</span><span class="p-dur">0:00</span></div>' +
            '    <div class="p-ctrls" data-group="ctrls"></div>' +
            '  </div>' +
            '</div>';

        var video = s.el.querySelector('video');
        var subsEl = s.el.querySelector('.subs');
        var spinner = s.el.querySelector('.p-spinner');
        var osd = s.el.querySelector('.osd');
        var bar = s.el.querySelector('.p-bar');
        var seekLabel = s.el.querySelector('.p-seek');
        var seekHint = s.el.querySelector('.p-seekhint');
        var ctrls = s.el.querySelector('.p-ctrls');

        var state = {
            tr: ctx.translatorId,
            season: ctx.season,
            episode: ctx.episode,
            qualities: [],
            qIdx: 0,
            urlIdx: 0,
            subs: [],
            subIdx: -1,
            cues: [],
            startAt: 0,
            pendingSeek: null,
            closed: false,
            lastServerSave: 0,
            lastLocalSave: 0
        };
        var hideTimer = null, seekTimer = null, osdVisible = false;

        function translator() {
            return d.translators.filter(function (t) { return t.id === state.tr; })[0] || d.translators[0];
        }

        function episodeList() {
            var out = [];
            d.seasons.forEach(function (se) {
                (d.episodes[se.id] || []).forEach(function (ep) { out.push(ep); });
            });
            return out;
        }

        function neighbour(delta) {
            var list = episodeList();
            for (var i = 0; i < list.length; i++) {
                if (list[i].season === state.season && list[i].episode === state.episode) return list[i + delta] || null;
            }
            return null;
        }

        function titles() {
            s.el.querySelector('.p-title').textContent = d.title;
            var sub = [];
            if (d.isSeries) sub.push('Сезон ' + state.season + ', серия ' + state.episode);
            var t = translator();
            if (t) sub.push(t.name);
            var q = state.qualities[state.qIdx];
            if (q) sub.push(q.name);
            s.el.querySelector('.p-sub').textContent = sub.join('  •  ');
        }

        function button(label, fn, cls) {
            var b = h('div', 'p-btn focusable' + (cls ? ' ' + cls : ''), esc(label));
            b.onclick = fn;
            ctrls.appendChild(b);
            return b;
        }

        function buildControls() {
            var keep = Nav.current() && Nav.current().getAttribute('data-id');
            ctrls.innerHTML = '';
            button(video.paused ? '▶' : '❚❚', togglePlay, 'icon').setAttribute('data-id', 'play');
            button('−30 с', function () { seekBy(-30); }).setAttribute('data-id', 'rw');
            button('+30 с', function () { seekBy(30); }).setAttribute('data-id', 'ff');
            if (d.isSeries) {
                var prev = neighbour(-1), next = neighbour(1);
                var bp = button('Пред. серия', function () { if (prev) switchEpisode(prev); });
                bp.setAttribute('data-id', 'prev');
                if (!prev) bp.classList.add('disabled');
                var bn = button('След. серия', function () { if (next) switchEpisode(next); });
                bn.setAttribute('data-id', 'next');
                if (!next) bn.classList.add('disabled');
                button('Серии', chooseEpisode).setAttribute('data-id', 'eps');
            }
            var q = state.qualities[state.qIdx];
            button('Качество: ' + (q ? q.name : '—'), chooseQuality).setAttribute('data-id', 'q');
            if (state.subs.length) {
                button('Субтитры: ' + (state.subIdx >= 0 ? state.subs[state.subIdx].name : 'выкл'), chooseSubs).setAttribute('data-id', 'subs');
            }
            if (d.translators.length > 1) button('Озвучка', chooseTranslator).setAttribute('data-id', 'tr');
            if (keep) {
                var el = ctrls.querySelector('[data-id="' + keep + '"]');
                if (el) Nav.focus(el);
            }
        }

        /* ---------- OSD ---------- */

        function showOsd(focusBar) {
            osd.classList.remove('hidden');
            s.el.classList.add('osd-on');
            osdVisible = true;
            if (focusBar || !Nav.current()) Nav.focus(bar);
            armHide();
        }

        function hideOsd() {
            osd.classList.add('hidden');
            s.el.classList.remove('osd-on');
            osdVisible = false;
            clearTimeout(hideTimer);
        }

        function armHide() {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(function () {
                if (!video.paused && state.pendingSeek === null) hideOsd();
            }, 5000);
        }

        function renderProgress() {
            var dur = video.duration || 0;
            var t = state.pendingSeek !== null ? state.pendingSeek : video.currentTime;
            var pct = dur ? Math.min(100, t / dur * 100) : 0;
            s.el.querySelector('.p-prog').style.width = pct + '%';
            s.el.querySelector('.p-knob').style.left = pct + '%';
            if (dur && video.buffered.length) {
                s.el.querySelector('.p-buf').style.width = Math.min(100, video.buffered.end(video.buffered.length - 1) / dur * 100) + '%';
            }
            s.el.querySelector('.p-cur').textContent = fmtTime(t);
            s.el.querySelector('.p-dur').textContent = fmtTime(dur);
        }

        /* ---------- playback ---------- */

        function setSpinner(on) { spinner.classList.toggle('hidden', !on); }

        function playCurrent(startAt) {
            var q = state.qualities[state.qIdx];
            if (!q) return fail('Нет доступных потоков');
            state.startAt = startAt || 0;
            setSpinner(true);
            // A stalled stream never fires "error"; move on to the next URL instead of spinning forever
            clearTimeout(state.loadTimer);
            state.loadTimer = setTimeout(function () {
                if (!state.closed && video.readyState === 0) onError();
            }, 25000);
            video.src = q.urls[state.urlIdx];
            video.load();
            var p = video.play();
            if (p && p.catch) p.catch(function () { /* autoplay errors surface via the error event */ });
            titles();
            buildControls();
        }

        function fail(msg) {
            setSpinner(false);
            Toast(msg, 5000);
        }

        function onError() {
            if (state.closed || !video.getAttribute('src')) return;
            var q = state.qualities[state.qIdx];
            var at = video.currentTime || state.startAt;
            if (q && state.urlIdx + 1 < q.urls.length) {
                state.urlIdx++;
                return playCurrent(at);
            }
            if (state.qIdx > 0) {
                state.qIdx--;
                state.urlIdx = 0;
                Toast('Поток недоступен, пробую ' + state.qualities[state.qIdx].name);
                return playCurrent(at);
            }
            fail('Не удалось воспроизвести видео');
        }

        function loadStream(startAt, keepQuality) {
            var prevName = keepQuality && state.qualities[state.qIdx] ? state.qualities[state.qIdx].name : null;
            setSpinner(true);
            var req = d.isSeries ?
                Api.getStream(d.id, state.tr, state.season, state.episode) :
                Api.getMovie(d.id, translator());
            return req.then(function (r) {
                if (state.closed) return;
                state.qualities = r.qualities;
                state.subs = r.subs;
                state.urlIdx = 0;
                state.qIdx = preferredQuality(r.qualities);
                if (prevName) {
                    r.qualities.forEach(function (q, i) { if (q.name === prevName) state.qIdx = i; });
                }
                state.subIdx = -1;
                state.cues = [];
                subsEl.textContent = '';
                var t = translator();
                if (r.subs.length && t && /оригинал|субтитр/i.test(t.name)) {
                    var def = 0;
                    r.subs.forEach(function (sb, i) { if (r.subLangs[sb.name] === r.subDefault) def = i; });
                    selectSub(def);
                }
                playCurrent(startAt);
            }, function (e) {
                fail(e.message);
            });
        }

        function resumePoint() {
            var p = loadPos(d.id, state.season, state.episode);
            if (p && p.t > 30 && (!p.d || p.t < p.d - 60)) return p.t;
            return 0;
        }

        function persist(force) {
            var t = video.currentTime, dur = video.duration;
            if (!dur || !isFinite(dur) || t < 5) return;
            var now = Date.now();
            if (force || now - state.lastLocalSave > 10000) {
                state.lastLocalSave = now;
                savePos(d.id, state.season, state.episode, t, dur);
                Api.store('rz.last.' + d.id, JSON.stringify({ tr: state.tr, s: state.season, e: state.episode }));
            }
            if (force || now - state.lastServerSave > 60000) {
                state.lastServerSave = now;
                Api.sendSave(d.id, state.tr, state.season, state.episode, t, dur);
            }
        }

        function togglePlay() {
            if (video.paused) video.play(); else video.pause();
            showOsd();
        }

        function seekBy(delta) {
            var dur = video.duration || 0;
            if (!dur) return;
            var base = state.pendingSeek !== null ? state.pendingSeek : video.currentTime;
            state.pendingSeek = Math.max(0, Math.min(dur - 2, base + delta));
            seekLabel.textContent = fmtTime(state.pendingSeek);
            seekLabel.style.left = (state.pendingSeek / dur * 100) + '%';
            seekLabel.classList.add('show');
            seekHint.textContent = (delta > 0 ? '» ' : '« ') + fmtTime(state.pendingSeek);
            seekHint.classList.toggle('hidden', osdVisible);
            renderProgress();
            clearTimeout(seekTimer);
            seekTimer = setTimeout(function () {
                video.currentTime = state.pendingSeek;
                state.pendingSeek = null;
                seekLabel.classList.remove('show');
                seekHint.classList.add('hidden');
                armHide();
            }, 800);
        }

        function switchEpisode(ep) {
            persist(true);
            state.season = ep.season;
            state.episode = ep.episode;
            loadStream(resumePoint(), true);
        }

        /* ---------- menus ---------- */

        function chooseQuality() {
            showSelect('Качество', state.qualities.map(function (q, i) {
                return { label: q.name, premium: q.premium && !Api.session.premium, active: i === state.qIdx };
            }), function (o, i) {
                if (i === state.qIdx) return;
                state.qIdx = i;
                state.urlIdx = 0;
                playCurrent(video.currentTime);
            });
        }

        function selectSub(i) {
            state.subIdx = i;
            state.cues = [];
            subsEl.textContent = '';
            if (i < 0) return;
            Api.getText(state.subs[i].url).then(function (txt) {
                if (state.subIdx === i) state.cues = parseVtt(txt);
            }, function () { Toast('Не удалось загрузить субтитры'); });
        }

        function chooseSubs() {
            var opts = [{ label: 'Выключены', active: state.subIdx < 0 }].concat(state.subs.map(function (sb, i) {
                return { label: sb.name, active: i === state.subIdx };
            }));
            showSelect('Субтитры', opts, function (o, i) {
                selectSub(i - 1);
                buildControls();
            });
        }

        function chooseTranslator() {
            showSelect('Озвучка', d.translators.map(function (t) {
                return { label: t.name, premium: t.premium && !Api.session.premium, active: t.id === state.tr, tr: t };
            }), function (o) {
                if (o.tr.id === state.tr) return;
                var at = video.currentTime;
                state.tr = o.tr.id;
                if (!d.isSeries) return loadStream(at, true);
                // Episode lists differ between dubs
                Api.getEpisodes(d.id, state.tr).then(function (lists) {
                    d.seasons = lists.seasons;
                    d.episodes = lists.episodes;
                    var has = (d.episodes[state.season] || []).some(function (ep) { return ep.episode === state.episode; });
                    if (!has) {
                        var first = episodeList()[0];
                        if (!first) return fail('В этой озвучке нет серий');
                        state.season = first.season;
                        state.episode = first.episode;
                        at = 0;
                    }
                    loadStream(at, true);
                }, function (e) { fail(e.message); });
            });
        }

        function chooseEpisode() {
            var opts = [];
            episodeList().forEach(function (ep) {
                opts.push({
                    label: 'Сезон ' + ep.season + ' — ' + ep.name,
                    active: ep.season === state.season && ep.episode === state.episode,
                    ep: ep
                });
            });
            showSelect('Серии', opts, function (o) {
                if (!o.active) switchEpisode(o.ep);
            });
        }

        /* ---------- events ---------- */

        video.addEventListener('timeupdate', function () {
            if (osdVisible) renderProgress();
            persist(false);
            if (state.cues.length) {
                var t = video.currentTime;
                var lines = state.cues.filter(function (c) { return t >= c.s && t <= c.e; }).map(function (c) { return c.text; });
                var txt = lines.join('\n');
                if (subsEl.textContent !== txt) subsEl.textContent = txt;
            }
        });
        video.addEventListener('loadedmetadata', function () {
            clearTimeout(state.loadTimer);
            if (state.startAt > 0) {
                video.currentTime = state.startAt;
                Toast('Продолжение с ' + fmtTime(state.startAt));
                state.startAt = 0;
            }
            renderProgress();
        });
        video.addEventListener('waiting', function () { setSpinner(true); });
        video.addEventListener('playing', function () {
            if (state.closed) return;
            setSpinner(false);
            buildControls();
            armHide();
        });
        video.addEventListener('canplay', function () { setSpinner(false); });
        video.addEventListener('pause', function () {
            if (state.closed || Screens.top() !== s) return;
            buildControls();
            showOsd();
        });
        video.addEventListener('error', onError);
        video.addEventListener('ended', function () {
            persist(true);
            var next = d.isSeries ? neighbour(1) : null;
            if (next) {
                Toast('Следующая серия');
                switchEpisode(next);
            } else {
                Screens.pop();
            }
        });

        function onVisibility() {
            if (document.hidden) { persist(true); video.pause(); }
        }
        document.addEventListener('visibilitychange', onVisibility);

        /* ---------- keys ---------- */

        s.onKey = function (k) {
            switch (k) {
                case KEY.PLAYPAUSE: togglePlay(); return true;
                case KEY.PLAY: video.play(); showOsd(); return true;
                case KEY.PAUSE: video.pause(); return true;
                case KEY.STOP: Screens.pop(); return true;
                case KEY.FF: seekBy(30); if (!osdVisible) showOsd(true); return true;
                case KEY.RW: seekBy(-30); if (!osdVisible) showOsd(true); return true;
                case KEY.CHUP: if (d.isSeries && neighbour(1)) switchEpisode(neighbour(1)); return true;
                case KEY.CHDOWN: if (d.isSeries && neighbour(-1)) switchEpisode(neighbour(-1)); return true;
            }
            if (!osdVisible) {
                if (k === KEY.LEFT || k === KEY.RIGHT) { seekBy(k === KEY.LEFT ? -10 : 10); return true; }
                if (k === KEY.ENTER) { togglePlay(); return true; }
                if (k === KEY.UP || k === KEY.DOWN) { showOsd(true); return true; }
                return false;
            }
            armHide();
            if (Nav.current() === bar) {
                if (k === KEY.LEFT || k === KEY.RIGHT) { seekBy(k === KEY.LEFT ? -10 : 10); return true; }
                if (k === KEY.ENTER) { togglePlay(); return true; }
                if (k === KEY.UP) { hideOsd(); return true; }
                if (k === KEY.DOWN) {
                    Nav.focus(ctrls._last && ctrls.contains(ctrls._last) ? ctrls._last : ctrls.firstChild);
                    return true;
                }
            }
            return false;
        };

        s.onBack = function () {
            if (osdVisible && !video.paused) { hideOsd(); return true; }
            return false;
        };

        s.onClose = function () {
            state.closed = true;
            persist(true);
            clearTimeout(hideTimer);
            clearTimeout(seekTimer);
            clearTimeout(state.loadTimer);
            document.removeEventListener('visibilitychange', onVisibility);
            video.pause();
            video.removeAttribute('src');
            video.load();
            screensaver(true);
            if (ctx.onExit) ctx.onExit(state);
        };

        s.initialFocus = function () { return bar; };

        Screens.push(s);
        screensaver(false);
        titles();
        buildControls();
        showOsd(true);
        loadStream(ctx.startAt !== undefined ? ctx.startAt : resumePoint());
    }

    return { open: open, loadPos: loadPos };
})();
