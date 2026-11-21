/* Screens: login, main menu with catalog views, item details, settings */
(function () {
    'use strict';

    var VERSION = '1.0.0';

    var FILTERS = [
        { id: 'last', name: 'Последние' },
        { id: 'popular', name: 'Популярные' },
        { id: 'watching', name: 'Сейчас смотрят' },
        { id: 'soon', name: 'В ожидании' }
    ];

    var MENU = [
        { id: 'search', name: 'Поиск' },
        { id: 'home', name: 'Главная', section: '/' },
        { id: 'films', name: 'Фильмы', section: '/films/' },
        { id: 'series', name: 'Сериалы', section: '/series/' },
        { id: 'cartoons', name: 'Мультфильмы', section: '/cartoons/' },
        { id: 'animation', name: 'Аниме', section: '/animation/' },
        { id: 'continue', name: 'Досмотреть' },
        { id: 'favorites', name: 'Закладки' },
        { id: 'settings', name: 'Настройки' }
    ];

    // Main-screen views whose data changed on another screen and must be reloaded on return
    var dirty = {};

    /* ---------- per-item marks: in history / watched / bookmarked ---------- */

    // The site's catalog cards carry no user state, so the app indexes the account's
    // history and bookmarks itself and decorates cards with data-id
    var Marks = (function () {
        var MAX_FAV_PAGES = 30;
        var hist = {}, fav = {}, gen = 0;

        function postId(item) {
            return item.id || Api.postIdFromUrl(item.url);
        }

        function decorate(card) {
            var id = card.getAttribute('data-id');
            var box = card.querySelector('.marks');
            if (!box) return;
            var html = '', state = hist[id] ? hist[id].state : '';
            if (state === 'watched') html += '<span class="mark watched">Просмотрено</span>';
            else if (state === 'continue') html += '<span class="mark continue">Досмотреть</span>';
            if (fav[id]) html += '<span class="mark fav">В закладках</span>';
            box.innerHTML = html;
        }

        function refresh() {
            Array.prototype.forEach.call(document.querySelectorAll('.card[data-id]'), decorate);
        }

        function setHistoryList(list) {
            hist = {};
            list.forEach(function (x) {
                if (x.id) hist[x.id] = { state: x.watched ? 'watched' : 'continue', saveId: x.saveId };
            });
            refresh();
        }

        function loadFavorites(my) {
            var next = {};
            function walk(catId, page) {
                return Api.favorites(catId, page).then(function (r) {
                    r.items.forEach(function (it) { if (it.id) next[it.id] = true; });
                    if (r.hasNext && r.items.length && page < MAX_FAV_PAGES) return walk(catId, page + 1);
                });
            }
            return Api.favoriteCategories().then(function (r) {
                return r.cats.reduce(function (p, c) {
                    return p.then(function () { return walk(c.id, 1); });
                }, Promise.resolve());
            }).then(function () {
                if (my !== gen) return;
                fav = next;
                refresh();
            });
        }

        // Background refresh; failures only mean cards stay unmarked
        function load() {
            if (!Api.session.logged) return;
            var my = ++gen;
            Api.continueList().then(function (list) { if (my === gen) setHistoryList(list); }).catch(function () {});
            loadFavorites(my).catch(function () {});
        }

        function clear() {
            gen++;
            hist = {};
            fav = {};
            refresh();
        }

        return {
            postId: postId,
            decorate: decorate,
            load: load,
            clear: clear,
            setHistoryList: setHistoryList,
            // { state: 'watched' | 'continue', saveId } or null
            history: function (id) { return hist[id] || null; },
            setHistory: function (id, state, saveId) {
                if (!state) delete hist[id];
                else hist[id] = { state: state, saveId: saveId || (hist[id] && hist[id].saveId) || null };
                refresh();
            },
            setFavorite: function (id, on) {
                if (on) fav[id] = true; else delete fav[id];
                refresh();
            }
        };
    })();

    function handleError(e) {
        if (e && e.auth) {
            Toast('Сессия истекла — войдите снова');
            Screens.replaceAll(LoginScreen());
            return;
        }
        Toast(e && e.message ? e.message : 'Ошибка');
    }

    /* ---------- poster grid with endless paging ---------- */

    function Grid(container, loadPage, onPick) {
        var grid = h('div', 'grid');
        grid.setAttribute('data-group', 'grid');
        container.appendChild(grid);
        var items = [], page = 0, hasNext = true, loading = false, token = {};

        function card(item, idx) {
            var c = h('div', 'card focusable');
            var badge = item.info || item.typeName;
            c.innerHTML =
                '<div class="poster">' + (item.poster ? '<img src="' + esc(item.poster) + '">' : '') +
                '<div class="marks"></div>' +
                (badge ? '<span class="badge">' + esc(badge) + '</span>' : '') + '</div>' +
                '<div class="ctitle">' + esc(item.title) + '</div>' +
                '<div class="cmisc">' + esc(item.misc || '') + '</div>';
            var id = Marks.postId(item);
            if (id) {
                c.setAttribute('data-id', id);
                Marks.decorate(c);
            }
            c.onclick = function () { onPick(item); };
            c.onfocused = function () {
                if (idx >= items.length - 12) more();
            };
            return c;
        }

        function more() {
            if (loading || !hasNext) return Promise.resolve();
            loading = true;
            var my = token;
            var first = page === 0;
            if (first) grid.innerHTML = '<div class="empty">Загрузка…</div>';
            return loadPage(page + 1).then(function (r) {
                if (my !== token) return;
                loading = false;
                page++;
                hasNext = r.hasNext && r.items.length > 0;
                if (first) grid.innerHTML = '';
                r.items.forEach(function (it) {
                    grid.appendChild(card(it, items.length));
                    items.push(it);
                });
                if (first && !items.length) grid.innerHTML = '<div class="empty">Ничего не найдено</div>';
            }, function (e) {
                if (my !== token) return;
                loading = false;
                if (first) grid.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
                handleError(e);
            });
        }

        function reset(newLoad) {
            if (newLoad) loadPage = newLoad;
            token = {};
            items = [];
            page = 0;
            hasNext = true;
            loading = false;
            grid.innerHTML = '';
            grid._last = null;
            return more();
        }

        return { el: grid, more: more, reset: reset };
    }

    function tabs(container, list, activeId, onPick) {
        var row = h('div', 'tabs');
        row.setAttribute('data-group', 'tabs');
        list.forEach(function (t) {
            var b = h('div', 'tab focusable' + (t.id === activeId ? ' active' : ''), esc(t.name));
            b.onclick = function () {
                Array.prototype.forEach.call(row.children, function (x) { x.classList.remove('active'); });
                b.classList.add('active');
                onPick(t);
            };
            if (t.id === activeId) row._last = b;
            row.appendChild(b);
        });
        container.appendChild(row);
        return row;
    }

    /* ---------- main screen ---------- */

    function MainScreen(startView) {
        var s = { el: h('div', 'screen main') };
        s.el.innerHTML =
            '<nav class="sidebar"><div class="logo">Rezka<span>TV</span></div><div class="menu" data-group="menu"></div>' +
            '<div class="who"></div></nav>' +
            '<section class="content scroll-y" data-margin="140"></section>';
        var menu = s.el.querySelector('.menu');
        var content = s.el.querySelector('.content');
        var current = null;

        function updateWho() {
            var ses = Api.session;
            s.el.querySelector('.who').textContent = ses.logged ? (ses.premium ? 'Premium' : 'Бесплатный аккаунт') : 'Гость';
        }

        MENU.forEach(function (m) {
            var b = h('div', 'menu-item focusable', esc(m.name));
            b.setAttribute('data-id', m.id);
            b.onclick = function () {
                open(m.id);
                var f = content.querySelector('.default-focus') || content.querySelector('.focusable');
                if (f) Nav.focus(f);
            };
            menu.appendChild(b);
        });

        function open(id) {
            var m = MENU.filter(function (x) { return x.id === id; })[0];
            current = id;
            Array.prototype.forEach.call(menu.children, function (b) {
                b.classList.toggle('active', b.getAttribute('data-id') === id);
            });
            menu._last = menu.querySelector('[data-id="' + id + '"]');
            content.innerHTML = '';
            content.scrollTop = 0;
            if (m.section) catalogView(m);
            else if (id === 'search') searchView();
            else if (id === 'continue') continueView();
            else if (id === 'favorites') favoritesView();
            else if (id === 'settings') settingsView();
        }

        function header(title) {
            content.appendChild(h('h2', 'view-title', esc(title)));
        }

        function catalogView(m) {
            header(m.name);
            var filter = Api.store('rz.filter.' + m.id) || 'last';
            var grid;
            tabs(content, FILTERS, filter, function (t) {
                filter = t.id;
                Api.store('rz.filter.' + m.id, filter);
                grid.reset();
            });
            grid = Grid(content, function (page) { return Api.listing(m.section, filter, page); }, openDetails);
            grid.more();
        }

        function searchView() {
            header('Поиск');
            var lastQuery = Api.store('rz.lastSearch') || '';
            var row = h('div', 'search-row');
            var input = makeInput('Название фильма или сериала', 'text', run);
            input.classList.add('default-focus');
            input.value = lastQuery;
            row.appendChild(input);
            var go = h('div', 'btn focusable', 'Найти');
            go.onclick = function () { run(input.value); };
            row.appendChild(go);
            content.appendChild(row);
            var grid = Grid(content, function () { return Promise.resolve({ items: [], hasNext: false }); }, openDetails);

            function run(q) {
                q = (q || '').trim();
                if (!q) return;
                Api.store('rz.lastSearch', q);
                grid.reset(function (page) { return Api.search(q, page); }).then(function () {
                    var f = grid.el.querySelector('.card');
                    if (f) Nav.focus(f);
                });
            }
            if (lastQuery) run(lastQuery);
        }

        function continueView() {
            header('Досмотреть');
            if (!Api.session.logged) {
                content.appendChild(h('div', 'empty', 'Доступно после входа в аккаунт'));
                return;
            }
            // The site keeps one history list; "watched" is a flag on each entry
            var tab = Api.store('rz.histTab') || 'continue';
            var list = null;
            var grid = Grid(content, function (page) {
                if (page > 1) return Promise.resolve({ items: [], hasNext: false });
                return (list ? Promise.resolve(list) : Api.continueList()).then(function (all) {
                    if (!list) Marks.setHistoryList(all);
                    list = all;
                    return {
                        items: all.filter(function (x) { return x.watched === (tab === 'watched'); }).map(function (x) {
                            return {
                                id: x.id, url: x.url, title: x.title, poster: x.poster, misc: x.info, saveId: x.saveId, watched: x.watched,
                                info: x.extra && !x.watched ? 'Новые серии' : ''
                            };
                        }),
                        hasNext: false
                    };
                });
            }, openDetails);
            var tabRow = tabs(h('div'), [
                { id: 'continue', name: 'Досмотреть' },
                { id: 'watched', name: 'Просмотрено' }
            ], tab, function (t) {
                tab = t.id;
                Api.store('rz.histTab', tab);
                grid.reset();
            });
            // After returning from a changed item the view is rebuilt; land on the open tab
            if (tabRow._last) tabRow._last.classList.add('default-focus');
            content.insertBefore(tabRow, grid.el);
            grid.el.classList.add('no-hist-marks');
            grid.more();
        }

        function favoritesView() {
            header('Закладки');
            if (!Api.session.logged) {
                content.appendChild(h('div', 'empty', 'Доступно после входа в аккаунт'));
                return;
            }
            var holder = h('div');
            content.appendChild(holder);
            var gridHolder = h('div');
            content.appendChild(gridHolder);
            var catId = null, grid = null;
            Loader.wrap(Api.favoriteCategories()).then(function (r) {
                if (!r.cats.length) {
                    gridHolder.appendChild(h('div', 'empty', 'Закладок пока нет'));
                    return;
                }
                catId = Api.store('rz.favcat') || r.cats[0].id;
                if (!r.cats.some(function (c) { return c.id === catId; })) catId = r.cats[0].id;
                tabs(holder, r.cats.map(function (c) {
                    return { id: c.id, name: c.name + (c.count ? ' (' + c.count + ')' : '') };
                }), catId, function (t) {
                    catId = t.id;
                    Api.store('rz.favcat', catId);
                    grid.reset();
                });
                grid = Grid(gridHolder, function (page) { return Api.favorites(catId, page); }, openDetails);
                grid.el.classList.add('no-fav-marks');
                grid.more();
            }, handleError);
        }

        function settingsView() {
            header('Настройки');
            var box = h('div', 'settings');
            content.appendChild(box);
            var ses = Api.session;

            function row(label, value, fn) {
                var r = h('div', 'set-row focusable', '<span>' + esc(label) + '</span><b>' + esc(value) + '</b>');
                r.onclick = fn;
                box.appendChild(r);
                return r;
            }

            row('Аккаунт', ses.logged ? (ses.premium ? 'Premium' : 'Бесплатный') : 'Не выполнен вход', function () {
                if (!ses.logged) return Screens.replaceAll(LoginScreen());
                showSelect('Аккаунт', [{ label: 'Выйти из аккаунта' }, { label: 'Отмена' }], function (o, i) {
                    if (i !== 0) return;
                    Loader.wrap(Api.logout()).then(function () {
                        Marks.clear();
                        Screens.replaceAll(LoginScreen());
                    });
                });
            }).classList.add('default-focus');

            var qNames = { max: 'Максимальное', '1080p': '1080p', '720p': '720p', '480p': '480p' };
            var q = Api.store('rz.quality') || 'max';
            row('Качество по умолчанию', qNames[q], function () {
                showSelect('Качество по умолчанию', Object.keys(qNames).map(function (k) {
                    return { label: qNames[k], active: k === q, key: k };
                }), function (o) {
                    Api.store('rz.quality', o.key);
                    open('settings');
                });
            });

            var mirrorRow = h('div', 'set-row set-input');
            mirrorRow.appendChild(h('span', '', 'Зеркало сайта'));
            var input = makeInput('standby-rezka.tv', 'text', function (v) {
                Api.setMirror(v);
                Toast('Зеркало: ' + Api.mirror().replace(/^https?:\/\//, ''));
                start();
            });
            input.value = Api.mirror().replace(/^https?:\/\//, '');
            mirrorRow.appendChild(input);
            box.appendChild(mirrorRow);

            box.appendChild(h('div', 'set-note', 'Rezka TV ' + VERSION + ' · неофициальный клиент HDrezka для Samsung Tizen'));
        }

        s.onShow = function () {
            updateWho();
            if (dirty[current]) open(current);
            dirty = {};
        };
        s.onBack = function () {
            var curEl = Nav.current();
            if (curEl && !curEl.closest('.sidebar')) {
                Nav.focus(menu._last || menu.firstChild);
                return true;
            }
            return false;
        };
        s.initialFocus = function () {
            return content.querySelector('.default-focus') || content.querySelector('.focusable') || menu._last;
        };

        open(startView || 'home');
        updateWho();
        Marks.load();
        s.open = open;
        return s;
    }

    /* ---------- details ---------- */

    function openDetails(item) {
        Loader.wrap(Api.details(item.url)).then(function (d) {
            Screens.push(DetailsScreen(d, item));
        }, handleError);
    }

    function DetailsScreen(d, item) {
        var s = { el: h('div', 'screen details') };
        var last = null;
        try { last = JSON.parse(Api.store('rz.last.' + d.id) || 'null'); } catch (e) { /* ignore */ }

        var sel = {
            tr: (last && last.tr && d.translators.some(function (t) { return t.id === last.tr; })) ? last.tr : d.translatorId,
            season: d.season,
            episode: d.episode
        };
        if (last && d.isSeries && last.tr === sel.tr && last.s) {
            sel.season = last.s;
            sel.episode = last.e;
        }
        var shownSeason = sel.season;

        function trName() {
            var t = d.translators.filter(function (x) { return x.id === sel.tr; })[0];
            return t ? t.name : '';
        }

        function watchedMark(season, episode) {
            var p = Player.loadPos(d.id, season, episode);
            if (!p || !p.d) return '';
            return p.t > p.d - 120 ? 'watched' : 'started';
        }

        function render() {
            var poster = d.posterBig || d.poster || (item && item.poster) || '';
            var meta = d.info.filter(function (i) {
                return /Дата выхода|Год|Страна|Жанр|Режиссер|Время|Возраст|В качестве/i.test(i.label);
            });
            var html =
                '<div class="d-bg" style="background-image:url(\'' + esc(poster) + '\')"></div>' +
                '<div class="d-shade"></div>' +
                '<div class="d-scroll scroll-y" data-margin="80">' +
                '<div class="d-top">' +
                '<div class="d-poster">' + (d.poster ? '<img src="' + esc(d.poster) + '">' : '') + '</div>' +
                '<div class="d-info">' +
                '<h1>' + esc(d.title) + '</h1>' +
                (d.orig ? '<div class="d-orig">' + esc(d.orig) + '</div>' : '') +
                '<div class="d-ratings">' + d.ratings.map(function (r) {
                    return '<span><b>' + esc(r.name) + '</b> ' + esc(r.value) + '</span>';
                }).join('') + '</div>' +
                '<table class="d-meta">' + meta.map(function (i) {
                    return '<tr><td>' + esc(i.label) + '</td><td>' + esc(i.value) + '</td></tr>';
                }).join('') + '</table>' +
                '<p class="d-desc">' + esc(d.desc) + '</p>' +
                '<div class="d-actions" data-group="actions"></div>' +
                '</div></div>' +
                '<div class="d-series"></div>' +
                '<div class="d-cast"></div>' +
                '</div>';
            s.el.innerHTML = html;
            renderCast();
            var actions = s.el.querySelector('.d-actions');

            if (!d.translatorId) {
                actions.appendChild(h('div', 'd-msg', esc(d.message || 'Видео недоступно')));
                // Upcoming releases have no video yet but often have a trailer
                renderTrailer(actions);
                return;
            }

            var playLabel = '▶  Смотреть';
            if (d.isSeries) playLabel += '  · С' + sel.season + ' Е' + sel.episode;
            var pos = Player.loadPos(d.id, d.isSeries ? sel.season : 0, d.isSeries ? sel.episode : 0);
            if (pos && pos.t > 30 && pos.t < pos.d - 60) playLabel = '▶  Продолжить' + (d.isSeries ? ' · С' + sel.season + ' Е' + sel.episode : '') + ' с ' + fmtTime(pos.t);
            var play = h('div', 'btn primary focusable default-focus', esc(playLabel));
            play.onclick = function () { startPlayback(sel.season, sel.episode); };
            actions.appendChild(play);

            if (pos && pos.t > 30) {
                var restart = h('div', 'btn focusable', 'С начала');
                restart.onclick = function () { startPlayback(sel.season, sel.episode, 0); };
                actions.appendChild(restart);
            }

            if (d.translators.length > 1) {
                var tb = h('div', 'btn focusable', 'Озвучка: ' + esc(trName()));
                tb.onclick = chooseTranslator;
                actions.appendChild(tb);
            }

            renderTrailer(actions);
            renderAccountActions(actions);
            if (d.isSeries) renderSeries();
        }

        function renderCast() {
            if (!d.persons || !d.persons.length) return;
            var box = s.el.querySelector('.d-cast');
            box.appendChild(h('h3', '', 'Актёры и съёмочная группа'));
            var row = h('div', 'cast scroll-x');
            row.setAttribute('data-group', 'cast');
            d.persons.forEach(function (p) {
                row.appendChild(personChip(p));
            });
            box.appendChild(row);
        }

        function renderTrailer(actions) {
            var save = currentSave();
            if (!d.hasTrailer || !d.id || (save && save.state === 'watched')) return;
            var b = h('div', 'btn focusable', 'Трейлер');
            b.onclick = function () { openTrailer(d); };
            actions.appendChild(b);
        }

        function renderAccountActions(actions) {
            if (d.favCats) {
                var inFav = d.favCats.some(function (c) { return c.checked; });
                var fav = h('div', 'btn focusable' + (inFav ? ' on' : ''), inFav ? 'В закладках' : 'В закладки');
                fav.onclick = chooseFavorite;
                actions.appendChild(fav);
            }
            if (!Api.session.logged || !d.id) return;
            var save = currentSave();
            // Without an entry, marking as watched first creates one, which needs a voice-over
            if (!save && !d.translatorId) return;
            var watched = !!save && save.state === 'watched';
            var w = h('div', 'btn focusable' + (watched ? ' on' : ''), watched ? 'Просмотрено' : 'Отметить просмотренным');
            w.onclick = toggleWatched;
            actions.appendChild(w);
            if (save) {
                var del = h('div', 'btn focusable', 'Удалить из истории');
                del.onclick = removeFromHistory;
                actions.appendChild(del);
            }
        }

        // The history entry of this item, if known; Marks has the freshest state
        function currentSave() {
            var m = d.id && Marks.history(d.id);
            if (m && m.saveId) return m;
            if (item && item.saveId) return { state: item.watched ? 'watched' : 'continue', saveId: item.saveId };
            return null;
        }

        function findOrCreateSave() {
            function lookup() {
                return Api.continueList().then(function (list) {
                    Marks.setHistoryList(list);
                    return Marks.history(d.id);
                });
            }
            // Re-check the site first: creating an entry for an item already in history would reset its progress
            return lookup().then(function (found) {
                if (found) return found;
                return Api.createSave(d.id, sel.tr, d.isSeries ? sel.season : 0, d.isSeries ? sel.episode : 0)
                    .then(lookup)
                    .then(function (created) {
                        if (!created) throw new Error('Не удалось добавить в историю просмотра');
                        return created;
                    });
            });
        }

        function rerenderKeeping(btnLabel) {
            render();
            var btn = Array.prototype.filter.call(s.el.querySelectorAll('.d-actions .btn'), function (b) {
                return b.textContent === btnLabel;
            })[0];
            Nav.focus(btn || s.el.querySelector('.default-focus') || Nav.first());
        }

        function toggleFav(cat) {
            return Loader.wrap(Api.toggleFavorite(d.id, cat.id)).then(function () {
                cat.checked = !cat.checked;
                dirty.favorites = true;
                Marks.setFavorite(d.id, d.favCats.some(function (c) { return c.checked; }));
                Toast(cat.checked ? 'Добавлено в «' + cat.name + '»' : 'Удалено из «' + cat.name + '»');
                rerenderKeeping(d.favCats.some(function (c) { return c.checked; }) ? 'В закладках' : 'В закладки');
            }, handleError);
        }

        function chooseFavorite() {
            if (!d.favCats.length) {
                // A fresh account has no bookmark categories yet
                return Loader.wrap(Api.addFavoriteCategory('Закладки')).then(function (cat) {
                    d.favCats.push(cat);
                    return toggleFav(cat);
                }, handleError);
            }
            if (d.favCats.length === 1) return toggleFav(d.favCats[0]);
            showSelect('Разделы закладок', d.favCats.map(function (c) {
                return { label: c.name, sub: c.checked ? 'Добавлено — нажмите, чтобы убрать' : '', active: c.checked, cat: c };
            }), function (o) { toggleFav(o.cat); });
        }

        function toggleWatched() {
            var known = currentSave();
            var want = !(known && known.state === 'watched');
            var work = (known ? Promise.resolve(known) : findOrCreateSave()).then(function (save) {
                // A fresh lookup may show the entry is already in the wanted state
                if ((save.state === 'watched') === want) return save;
                return Api.toggleSaveWatched(save.saveId).then(function () { return save; });
            });
            Loader.wrap(work).then(function (save) {
                if (item && item.saveId === save.saveId) item.watched = want;
                dirty['continue'] = true;
                Marks.setHistory(d.id, want ? 'watched' : 'continue', save.saveId);
                Toast(want ? 'Отмечено как просмотренное' : 'Возвращено в «Досмотреть»');
                rerenderKeeping(want ? 'Просмотрено' : 'Отметить просмотренным');
            }, handleError);
        }

        function removeFromHistory() {
            showSelect('Удалить «' + d.title + '» из истории просмотра?', [
                { label: 'Удалить' }, { label: 'Отмена' }
            ], function (o, i) {
                if (i !== 0) return;
                var save = currentSave();
                if (!save) return;
                Loader.wrap(Api.removeSave(save.saveId)).then(function () {
                    dirty['continue'] = true;
                    Marks.setHistory(d.id, null);
                    Toast('Удалено из истории');
                    Screens.pop();
                }, handleError);
            });
        }

        function renderSeries() {
            var box = s.el.querySelector('.d-series');
            box.innerHTML = '';
            if (!d.seasons.length) {
                box.appendChild(h('div', 'd-msg', 'В этой озвучке нет серий'));
                return;
            }
            if (!d.episodes[shownSeason]) shownSeason = d.seasons[0].id;
            if (d.seasons.length > 1) {
                box.appendChild(h('h3', '', 'Сезоны'));
                var srow = h('div', 'chips scroll-x');
                srow.setAttribute('data-group', 'seasons');
                d.seasons.forEach(function (se) {
                    var c = h('div', 'chip focusable' + (se.id === shownSeason ? ' active' : ''), esc(se.name));
                    c.onclick = function () {
                        shownSeason = se.id;
                        renderSeries();
                        var f = s.el.querySelector('.chips[data-group="seasons"] .chip.active');
                        if (f) Nav.focus(f);
                    };
                    if (se.id === shownSeason) srow._last = c;
                    srow.appendChild(c);
                });
                box.appendChild(srow);
            }
            box.appendChild(h('h3', '', 'Серии'));
            var erow = h('div', 'chips eps');
            erow.setAttribute('data-group', 'episodes');
            (d.episodes[shownSeason] || []).forEach(function (ep) {
                var cur = ep.season === sel.season && ep.episode === sel.episode;
                var c = h('div', 'chip ep focusable ' + watchedMark(ep.season, ep.episode) + (cur ? ' active' : ''), esc(ep.name));
                c.onclick = function () { startPlayback(ep.season, ep.episode); };
                if (cur) erow._last = c;
                erow.appendChild(c);
            });
            box.appendChild(erow);
        }

        function chooseTranslator() {
            showSelect('Озвучка', d.translators.map(function (t) {
                return { label: t.name, premium: t.premium && !Api.session.premium, active: t.id === sel.tr, tr: t };
            }), function (o) {
                if (o.tr.id === sel.tr) return;
                sel.tr = o.tr.id;
                if (!d.isSeries) { render(); refocus(); return; }
                Loader.wrap(Api.getEpisodes(d.id, sel.tr)).then(function (lists) {
                    d.seasons = lists.seasons;
                    d.episodes = lists.episodes;
                    var eps = d.episodes[sel.season] || [];
                    if (!eps.some(function (ep) { return ep.episode === sel.episode; })) {
                        var firstSeason = d.seasons[0];
                        var first = firstSeason && (d.episodes[firstSeason.id] || [])[0];
                        sel.season = first ? first.season : null;
                        sel.episode = first ? first.episode : null;
                    }
                    shownSeason = sel.season;
                    render();
                    refocus();
                }, handleError);
            });
        }

        function refocus() {
            Nav.focus(s.el.querySelector('.default-focus') || Nav.first());
        }

        function startPlayback(season, episode, startAt) {
            if (d.isSeries && !season) return Toast('Нет доступных серий');
            Player.open({
                details: d,
                translatorId: sel.tr,
                season: d.isSeries ? season : 0,
                episode: d.isSeries ? episode : 0,
                startAt: startAt,
                onExit: function (st) {
                    // The site adds anything played to the history
                    if (!Marks.history(d.id)) Marks.setHistory(d.id, 'continue');
                    sel.tr = st.tr;
                    if (d.isSeries) {
                        sel.season = st.season;
                        sel.episode = st.episode;
                        shownSeason = st.season;
                    }
                    s.needsRender = true;
                }
            });
        }

        s.onShow = function () {
            if (s.needsRender) {
                s.needsRender = false;
                s.saved = null;
                render();
            }
        };
        s.initialFocus = function () { return s.el.querySelector('.default-focus'); };
        // The item page is the freshest source of the bookmark state
        if (d.favCats && d.id) Marks.setFavorite(d.id, d.favCats.some(function (c) { return c.checked; }));
        render();
        return s;
    }

    /* ---------- people ---------- */

    function initials(name) {
        return name.split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
    }

    function personChip(p) {
        var c = h('div', 'person focusable');
        c.innerHTML =
            '<div class="avatar">' + (p.photo ? '<img src="' + esc(p.photo) + '">' : esc(initials(p.name))) + '</div>' +
            '<div class="pname">' + esc(p.name) + '</div>' +
            '<div class="pjob">' + esc(p.job) + '</div>';
        c.onclick = function () { openPerson(p); };
        return c;
    }

    function openPerson(p) {
        Loader.wrap(Api.person(p.url)).then(function (info) {
            Screens.push(PersonScreen(info, p));
        }, handleError);
    }

    function PersonScreen(info, p) {
        var s = { el: h('div', 'screen person-screen') };
        var photo = info.photo || p.photo;
        s.el.innerHTML =
            '<div class="p-scroll scroll-y" data-margin="80">' +
            '<div class="p-top">' +
            '<div class="p-photo">' + (photo ? '<img src="' + esc(photo) + '">' : '<span>' + esc(initials(info.name || p.name)) + '</span>') + '</div>' +
            '<div class="p-info">' +
            '<h1>' + esc(info.name || p.name) + '</h1>' +
            (info.orig ? '<div class="d-orig">' + esc(info.orig) + '</div>' : '') +
            '<table class="d-meta">' + info.info.map(function (i) {
                return '<tr><td>' + esc(i.label) + '</td><td>' + esc(i.value) + '</td></tr>';
            }).join('') + '</table>' +
            '</div></div>' +
            '<div class="p-careers"></div>' +
            '</div>';
        var careers = s.el.querySelector('.p-careers');
        if (!info.careers.length) careers.appendChild(h('div', 'empty', 'Фильмография не найдена'));
        var loads = info.careers.map(function (c, i) {
            careers.appendChild(h('h2', 'view-title', esc(c.title) +
                (c.stats ? ' <small>' + esc(c.stats) + '</small>' : '')));
            var grid = Grid(careers, function () {
                return Promise.resolve({ items: c.items, hasNext: false });
            }, openDetails);
            grid.el.setAttribute('data-group', 'career-' + i);
            return grid.more();
        });
        // Cards render a tick after the screen is shown
        Promise.all(loads).then(function () {
            if (Screens.top() === s && !s.el.contains(Nav.current())) Nav.focus(s.el.querySelector('.card'));
        });
        s.initialFocus = function () { return s.el.querySelector('.card'); };
        return s;
    }

    /* ---------- trailer ---------- */

    var YOUTUBE_APP = '9Ur5IzDKqV.TizenYouTube';

    function openInYouTube(videoId) {
        try {
            var data = [new tizen.ApplicationControlData('PAYLOAD', [JSON.stringify({ values: 'v=' + videoId })])];
            var ctrl = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view',
                'https://www.youtube.com/watch?v=' + videoId, null, null, data);
            tizen.application.launchAppControl(ctrl, YOUTUBE_APP, null, function () {
                // Deep link refused: at least open the app
                tizen.application.launch(YOUTUBE_APP, null, function () { Toast('Не удалось открыть YouTube'); });
            });
        } catch (e) {
            // Not on a TV
            window.open('https://www.youtube.com/watch?v=' + videoId);
        }
    }

    function openTrailer(d) {
        Loader.wrap(Api.trailer(d.id)).then(function (t) {
            Screens.push(TrailerScreen(t.videoId, d.title));
        }, handleError);
    }

    // YouTube embed driven through its postMessage API, so the remote keeps working
    // while focus stays in the app. Embeds can be refused (no referrer from a TV app),
    // so on error or silence it offers the YouTube app instead.
    function TrailerScreen(videoId, title) {
        var s = { el: h('div', 'screen trailer') };
        var frame = h('iframe');
        frame.setAttribute('allow', 'autoplay; encrypted-media');
        frame.setAttribute('tabindex', '-1');
        frame.src = 'https://www.youtube.com/embed/' + videoId +
            '?autoplay=1&enablejsapi=1&rel=0&iv_load_policy=3&modestbranding=1&playsinline=1';
        s.el.appendChild(frame);
        var bar = h('div', 'trailer-bar',
            '<b>' + esc(title) + ' — трейлер</b><span>OK — пауза · ◀ ▶ — 10 с · Back — закрыть</span>');
        s.el.appendChild(bar);
        var fallback = h('div', 'trailer-fallback hidden');
        s.el.appendChild(fallback);

        var state = { ready: false, playing: false, time: 0 };
        var timer = setTimeout(function () { if (!state.ready) fail(); }, 10000);

        function command(func, args) {
            try {
                frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [] }), '*');
            } catch (e) { /* frame gone */ }
        }

        function fail() {
            if (!fallback.classList.contains('hidden')) return;
            frame.style.visibility = 'hidden';
            bar.classList.add('hidden');
            fallback.innerHTML = '<p>Встроенный трейлер не воспроизводится на этом телевизоре.</p>';
            var btn = h('div', 'btn primary focusable default-focus', 'Открыть в YouTube');
            btn.onclick = function () { openInYouTube(videoId); };
            fallback.appendChild(btn);
            fallback.classList.remove('hidden');
            Nav.focus(btn);
        }

        function onMessage(e) {
            if (!/youtube/.test(String(e.origin))) return;
            var msg;
            try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (err) { return; }
            if (!msg) return;
            if (msg.event === 'onReady' || msg.event === 'initialDelivery') state.ready = true;
            if (msg.event === 'onError') fail();
            var info = msg.info;
            if (msg.event === 'infoDelivery' && info) {
                state.ready = true;
                if (typeof info.currentTime === 'number') state.time = info.currentTime;
                if (typeof info.playerState === 'number') state.playing = info.playerState === 1;
            }
            if (msg.event === 'onStateChange' && typeof info === 'number') state.playing = info === 1;
        }
        window.addEventListener('message', onMessage);
        // Subscribe to the player's events
        frame.onload = function () {
            try { frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1 }), '*'); } catch (e) { /* ignore */ }
        };

        s.onKey = function (k) {
            if (!fallback.classList.contains('hidden')) return false;
            if (k === KEY.ENTER || k === KEY.PLAYPAUSE || k === KEY.PLAY || k === KEY.PAUSE) {
                command(state.playing ? 'pauseVideo' : 'playVideo');
                return true;
            }
            if (k === KEY.LEFT || k === KEY.RIGHT || k === KEY.RW || k === KEY.FF) {
                var back = k === KEY.LEFT || k === KEY.RW;
                state.time = Math.max(0, state.time + (back ? -10 : 10));
                command('seekTo', [state.time, true]);
                return true;
            }
            return k === KEY.UP || k === KEY.DOWN;
        };
        s.onClose = function () {
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            frame.src = 'about:blank';
        };
        return s;
    }

    /* ---------- login ---------- */

    function LoginScreen(message) {
        var s = { el: h('div', 'screen login') };
        var box = h('div', 'login-box');
        box.innerHTML = '<div class="logo big">Rezka<span>TV</span></div>' +
            '<div class="login-note">Войдите в аккаунт HDrezka.<br>Зеркало: ' + esc(Api.mirror().replace(/^https?:\/\//, '')) + '</div>' +
            '<div class="login-msg">' + esc(message || '') + '</div>';
        var email = makeInput('Email', 'email', function () { Nav.focus(pass); });
        email.classList.add('default-focus');
        email.value = Api.store('rz.email') || '';
        var pass = makeInput('Пароль', 'password', function () { Nav.focus(btn); });
        var btn = h('div', 'btn primary focusable', 'Войти');
        var mirrorBtn = h('div', 'btn focusable', 'Сменить зеркало');
        box.appendChild(email);
        box.appendChild(pass);
        var row = h('div', 'login-actions');
        row.appendChild(btn);
        row.appendChild(mirrorBtn);
        box.appendChild(row);
        s.el.appendChild(box);

        function msg(t) { box.querySelector('.login-msg').textContent = t; }

        btn.onclick = function () {
            var e = email.value.trim(), p = pass.value;
            if (!e || !p) return msg('Введите email и пароль');
            msg('');
            Loader.wrap(Api.login(e, p)).then(function () {
                Api.store('rz.email', e);
                Screens.replaceAll(MainScreen('home'));
            }, function (err) { msg(err.message); });
        };

        mirrorBtn.onclick = function () {
            var mirrorInput = makeInput('например standby-rezka.tv', 'text', function (v) {
                Api.setMirror(v);
                Screens.replaceAll(LoginScreen());
            });
            mirrorInput.value = Api.mirror().replace(/^https?:\/\//, '');
            row.parentNode.appendChild(mirrorInput);
            Nav.focus(mirrorInput);
            mirrorInput.focus();
        };

        return s;
    }

    /* ---------- boot ---------- */

    function registerKeys() {
        try {
            ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
                'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue'
            ].forEach(function (k) {
                try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* key not supported */ }
            });
        } catch (e) { /* not on a TV */ }
    }

    function onKey(e) {
        var k = e.keyCode;
        if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
        var top = Screens.top();
        if (top && top.onKey && top.onKey(k, e) === true) { e.preventDefault(); return; }
        switch (k) {
            case KEY.LEFT: Nav.move('left'); break;
            case KEY.RIGHT: Nav.move('right'); break;
            case KEY.UP: Nav.move('up'); break;
            case KEY.DOWN: Nav.move('down'); break;
            case KEY.ENTER: Nav.activate(); break;
            case KEY.BACK:
            case KEY.ESC:
            case KEY.BACKSPACE:
                Screens.back();
                break;
            default: return;
        }
        e.preventDefault();
    }

    function fitScreen() {
        // The UI is laid out for 1920x1080; scale it when run in a desktop browser
        var k = window.innerWidth / 1920;
        document.documentElement.style.zoom = Math.abs(k - 1) > 0.01 ? k : '';
    }

    function start() {
        Loader.wrap(Api.checkSession()).then(function (ses) {
            Screens.replaceAll(ses.logged ? MainScreen('home') : LoginScreen());
        }, function (e) {
            Screens.replaceAll(LoginScreen(e.message));
        });
    }

    window.RezkaApp = { start: start };

    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', fitScreen);
    fitScreen();
    registerKeys();
    start();
})();
