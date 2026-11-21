/* HDrezka site client: HTTP requests and HTML parsing */
var Api = (function () {
    'use strict';

    var DEFAULT_MIRROR = 'https://standby-rezka.tv';
    var session = { logged: false, premium: false, userId: null, favs: '' };

    function store(key, value) {
        try {
            if (value === undefined) return localStorage.getItem(key);
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch (e) { /* storage unavailable */ }
        return null;
    }

    function mirror() {
        // Desktop debugging: the dev server proxies the mirror under /rz
        if (location.hostname === 'localhost') return location.origin + '/rz';
        return (store('rz.mirror') || DEFAULT_MIRROR).replace(/\/+$/, '');
    }

    function setMirror(url) {
        url = (url || '').trim();
        if (!url) { store('rz.mirror', null); return; }
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        store('rz.mirror', url.replace(/\/+$/, ''));
    }

    // Links on the site are absolute to whatever host served the page; keep only the path
    function toPath(url) {
        if (!url) return '/';
        return url.replace(/^(https?:)?\/\/[^\/]+/i, '') || '/';
    }

    // Item pages look like /films/drama/12345-name.html
    function postIdFromUrl(url) {
        var m = (url || '').match(/\/(\d+)-[^\/]*\.html/);
        return m ? m[1] : '';
    }

    function abs(url) {
        if (/^https?:\/\//i.test(url)) return url;
        if (url.indexOf('//') === 0) return 'https:' + url;
        return mirror() + (url.charAt(0) === '/' ? '' : '/') + url;
    }

    function encode(data) {
        return Object.keys(data).map(function (k) {
            var v = data[k];
            return encodeURIComponent(k) + '=' + encodeURIComponent(v === null || v === undefined ? '' : v);
        }).join('&');
    }

    function request(method, url, data, ajax) {
        return new Promise(function (resolve, reject) {
            var x = new XMLHttpRequest();
            x.open(method, abs(url), true);
            x.withCredentials = true;
            x.timeout = 25000;
            if (data) x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
            if (ajax) x.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            x.onload = function () {
                if (x.status >= 200 && x.status < 400) resolve(x.responseText);
                else reject(new Error('Ошибка сервера: HTTP ' + x.status));
            };
            x.onerror = function () { reject(new Error('Нет соединения с ' + mirror().replace(/^https?:\/\//, ''))); };
            x.ontimeout = function () { reject(new Error('Сервер не отвечает')); };
            x.send(data ? encode(data) : null);
        });
    }

    function AuthError() {
        var e = new Error('Нужно войти в аккаунт');
        e.auth = true;
        return e;
    }

    function readSession(doc) {
        var uid = doc.querySelector('#member_user_id');
        session.logged = !!uid;
        session.userId = uid ? uid.value : null;
        // Free accounts get a "go Premium" link in the profile menu
        if (uid) session.premium = !doc.querySelector('.b-tophead-right .btn-prem');
        var favs = doc.querySelector('#ctrl_favs');
        if (favs) session.favs = favs.value;
    }

    function getDoc(url) {
        return request('GET', url).then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            if (doc.querySelector('#loginForm') && !doc.querySelector('#member_user_id')) {
                session.logged = false;
                throw AuthError();
            }
            readSession(doc);
            return { doc: doc, html: html };
        });
    }

    function ajax(url, data) {
        var sep = url.indexOf('?') < 0 ? '?' : '&';
        return request('POST', url + sep + 't=' + Date.now(), data, true).then(function (text) {
            var json;
            try { json = JSON.parse(text); } catch (e) { throw new Error('Некорректный ответ сервера'); }
            if (json.success === false) throw new Error(cleanMessage(json.message) || 'Сервер вернул ошибку');
            return json;
        });
    }

    function cleanMessage(msg) {
        if (!msg) return '';
        if (typeof msg === 'object') {
            var keys = Object.keys(msg);
            return keys.length ? cleanMessage(msg[keys[0]]) : '';
        }
        return String(msg).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function text(el) {
        return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    }

    function attr(el, name) {
        return el ? (el.getAttribute(name) || '') : '';
    }

    /* ---------- lists ---------- */

    function parseItems(root) {
        return Array.prototype.map.call(root.querySelectorAll('.b-content__inline_item'), function (el) {
            var link = el.querySelector('.b-content__inline_item-link a');
            var cat = el.querySelector('.cat');
            var info = el.querySelector('.b-content__inline_item-cover .info');
            return {
                id: attr(el, 'data-id'),
                url: toPath(attr(el, 'data-url') || attr(link, 'href')),
                title: text(link),
                misc: text(el.querySelector('.misc')),
                poster: attr(el.querySelector('.b-content__inline_item-cover img'), 'src'),
                type: cat ? cat.className.replace(/\bcat\b/, '').trim() : '',
                typeName: text(cat && cat.querySelector('.entity')),
                info: info ? info.innerHTML.replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, '').trim() : ''
            };
        });
    }

    function hasNext(doc) {
        var next = doc.querySelector('.b-navigation__next');
        return !!(next && next.closest('a'));
    }

    function listing(section, filter, page) {
        var url = section + (page > 1 ? 'page/' + page + '/' : '') + (filter ? '?filter=' + filter : '');
        return getDoc(url).then(function (r) {
            return { items: parseItems(r.doc), hasNext: hasNext(r.doc) };
        });
    }

    function search(query, page) {
        var url = '/search/?do=search&subaction=search&q=' + encodeURIComponent(query) + (page > 1 ? '&page=' + page : '');
        return getDoc(url).then(function (r) {
            return { items: parseItems(r.doc), hasNext: hasNext(r.doc) };
        });
    }

    function continueList() {
        return getDoc('/continue/').then(function (r) {
            var rows = r.doc.querySelectorAll('.b-videosaves__list_item[id^="videosave-"]');
            return Array.prototype.map.call(rows, function (row) {
                var a = row.querySelector('.td.title a');
                var info = row.querySelector('.td.info');
                var extra = info && info.querySelector('.info-holder');
                var main = info ? info.cloneNode(true) : null;
                if (main && main.querySelector('.info-holder')) main.removeChild(main.querySelector('.info-holder'));
                return {
                    saveId: row.id.replace('videosave-', ''),
                    id: postIdFromUrl(attr(a, 'href')),
                    watched: !!row.querySelector('.view.watched') || row.classList.contains('watched-row'),
                    url: toPath(attr(a, 'href')),
                    title: text(a),
                    poster: attr(a, 'data-cover_url'),
                    misc: text(row.querySelector('.td.title small')).replace(/^\(|\)$/g, ''),
                    info: text(main),
                    extra: text(extra),
                    date: text(row.querySelector('.td.date'))
                };
            });
        });
    }

    // Both toggles answer with {success, message}
    function removeSave(saveId) {
        return ajax('/engine/ajax/cdn_saves_remove.php', { id: saveId });
    }

    // An empty progress save puts the item into the history list
    function createSave(postId, trId, season, episode) {
        return ajax('/ajax/send_save/', {
            post_id: postId, translator_id: trId, season: season || 0, episode: episode || 0,
            current_time: 0, duration: 0
        });
    }

    function toggleSaveWatched(saveId) {
        return ajax('/engine/ajax/cdn_saves_view.php', { id: saveId });
    }

    // Adds the post to the category, or removes it if it is already there
    function toggleFavorite(postId, catId) {
        return ajax('/ajax/favorites/', { post_id: postId, cat_id: catId, action: 'add_post' });
    }

    function addFavoriteCategory(name) {
        return ajax('/ajax/favorites/', { name: name, action: 'add_cat' }).then(function (json) {
            return { id: String(json.id), name: json.name || name, checked: false };
        });
    }

    function favoriteCategories() {
        return getDoc('/favorites/').then(function (r) {
            var cats = r.doc.querySelectorAll('.b-favorites_content__cats_list_item');
            return {
                cats: Array.prototype.map.call(cats, function (c) {
                    var link = c.querySelector('.b-favorites_content__cats_list_link');
                    var name = c.querySelector('.name');
                    var num = c.querySelector('.num-holder, .num');
                    return {
                        id: attr(c, 'data-cat_id'),
                        name: text(name) || text(link).replace(/\d+\s*$/, '').trim(),
                        count: text(num).replace(/[()]/g, '')
                    };
                }),
                items: parseItems(r.doc),
                hasNext: hasNext(r.doc)
            };
        });
    }

    function favorites(catId, page) {
        var url = '/favorites/' + catId + '/' + (page > 1 ? 'page/' + page + '/' : '');
        return getDoc(url).then(function (r) {
            return { items: parseItems(r.doc), hasNext: hasNext(r.doc) };
        });
    }

    /* ---------- item page ---------- */

    function parseFlagged(el) {
        var name = attr(el, 'title').trim() || text(el);
        var flag = el.querySelector('img[title]');
        if (flag) name += ' (' + flag.getAttribute('title') + ')';
        return name;
    }

    function parseEpisodeLists(root) {
        var seasons = Array.prototype.map.call(root.querySelectorAll('.b-simple_season__item'), function (el) {
            return { id: attr(el, 'data-tab_id'), name: text(el) };
        });
        var episodes = {};
        Array.prototype.forEach.call(root.querySelectorAll('.b-simple_episode__item'), function (el) {
            var s = attr(el, 'data-season_id');
            (episodes[s] = episodes[s] || []).push({ season: s, episode: attr(el, 'data-episode_id'), name: text(el) });
        });
        // Single-season shows may come without a seasons tab list
        if (!seasons.length) {
            seasons = Object.keys(episodes).map(function (s) { return { id: s, name: 'Сезон ' + s }; });
        }
        return { seasons: seasons, episodes: episodes };
    }

    // Directors first, then actors in the site's order
    function parsePersons(doc) {
        var seen = {}, list = [];
        ['director', 'actor'].forEach(function (prop) {
            Array.prototype.forEach.call(doc.querySelectorAll('.person-name-item[itemprop="' + prop + '"]'), function (el) {
                var id = attr(el, 'data-id'), a = el.querySelector('a');
                if (!a || seen[id]) return;
                seen[id] = true;
                var photo = attr(el, 'data-photo');
                list.push({
                    id: id,
                    name: text(a),
                    job: attr(el, 'data-job') || (prop === 'director' ? 'Режиссер' : ''),
                    photo: /^https?:\/\//.test(photo) && !/nopersonphoto/.test(photo) ? photo : '',
                    url: toPath(attr(a, 'href'))
                });
            });
        });
        return list;
    }

    function person(url) {
        url = toPath(url);
        return getDoc(url).then(function (r) {
            var doc = r.doc;
            var info = [];
            Array.prototype.forEach.call(doc.querySelectorAll('.b-post__info tr, .b-person__info tr'), function (tr) {
                var cells = tr.querySelectorAll('td');
                if (cells.length < 2) return;
                var label = text(cells[0]).replace(/:$/, '');
                var value = text(cells[cells.length - 1]);
                if (label && value) info.push({ label: label, value: value });
            });
            return {
                name: text(doc.querySelector('h1 .t1')) || text(doc.querySelector('h1')),
                orig: text(doc.querySelector('h1 .t2')),
                photo: attr(doc.querySelector('img[itemprop="image"]'), 'src'),
                info: info,
                careers: Array.prototype.map.call(doc.querySelectorAll('.b-person__career'), function (c) {
                    return {
                        title: text(c.querySelector('h2')),
                        stats: text(c.querySelector('.b-person__career_stats')),
                        items: parseItems(c)
                    };
                }).filter(function (c) { return c.items.length; })
            };
        });
    }

    function parseDetails(url, doc, html) {
        var d = {
            url: url,
            title: text(doc.querySelector('.b-post__title h1')),
            orig: text(doc.querySelector('.b-post__origtitle')),
            poster: attr(doc.querySelector('.b-sidecover img'), 'src'),
            posterBig: attr(doc.querySelector('.b-sidecover a'), 'href'),
            desc: text(doc.querySelector('.b-post__description_text')),
            ratings: [],
            info: [],
            translators: [],
            seasons: [],
            episodes: {},
            isSeries: false,
            id: null,
            translatorId: null,
            season: null,
            episode: null,
            message: '',
            // null when the page has no bookmarks block (not logged in)
            favCats: null,
            hasTrailer: !!doc.querySelector('a.show-trailer[data-id]'),
            persons: parsePersons(doc)
        };

        if (doc.querySelector('#user-favorites-holder')) {
            d.favCats = Array.prototype.map.call(doc.querySelectorAll('#user-favorites-holder .user-fav-check'), function (el) {
                var label = doc.querySelector('label[for="' + el.id + '"]');
                var name = label ? label.cloneNode(true) : null;
                if (name && name.querySelector('small')) name.removeChild(name.querySelector('small'));
                return { id: el.value, name: text(name) || 'Закладки', checked: el.hasAttribute('checked') };
            });
        }

        Array.prototype.forEach.call(doc.querySelectorAll('.b-post__info_rates'), function (el) {
            var name = text(el.querySelector('a')) || (el.classList.contains('imdb') ? 'IMDb' : 'КП');
            var val = text(el.querySelector('.bold'));
            if (val) d.ratings.push({ name: name, value: val });
        });
        Array.prototype.forEach.call(doc.querySelectorAll('.b-post__info > tbody > tr, .b-post__info > tr'), function (tr) {
            var label = text(tr.querySelector('td.l')).replace(/:$/, '');
            var cells = tr.querySelectorAll('td');
            if (!label || cells.length < 2 || /Рейтинг/i.test(label)) return;
            var value = text(cells[cells.length - 1]);
            if (value) d.info.push({ label: label, value: value });
        });

        var init = html.match(/sof\.tv\.initCDN(Movies|Series)Events\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([^,]*),\s*([^,]*),\s*([^,]*),/);
        if (init) {
            d.isSeries = init[1] === 'Series';
            d.id = init[2];
            d.translatorId = init[3];
            if (d.isSeries) {
                d.season = String(parseInt(init[4], 10) || 1);
                d.episode = String(parseInt(init[5], 10) || 1);
            }
        } else {
            d.id = postIdFromUrl(url) || null;
            var restricted = doc.querySelector('.b-player__restricted, .b-post__status_wrapper, .b-player');
            d.message = text(restricted) || 'Видео недоступно';
        }

        var trs = doc.querySelectorAll('#translators-list .b-translator__item');
        d.translators = Array.prototype.map.call(trs, function (el) {
            return {
                id: attr(el, 'data-translator_id'),
                name: parseFlagged(el),
                premium: el.classList.contains('b-prem_translator'),
                camrip: attr(el, 'data-camrip') || '0',
                ads: attr(el, 'data-ads') || '0',
                director: attr(el, 'data-director') || '0'
            };
        });
        if (!d.translators.length && d.translatorId) {
            var row = d.info.filter(function (i) { return /переводе/i.test(i.label); })[0];
            d.translators.push({
                id: d.translatorId,
                name: row ? row.value : 'Оригинал',
                premium: false,
                camrip: init && !d.isSeries ? String(init[4]).replace(/\D/g, '') || '0' : '0',
                ads: init && !d.isSeries ? String(init[5]).replace(/\D/g, '') || '0' : '0',
                director: init && !d.isSeries ? String(init[6]).replace(/\D/g, '') || '0' : '0'
            });
        }

        if (d.isSeries) {
            var lists = parseEpisodeLists(doc);
            d.seasons = lists.seasons;
            d.episodes = lists.episodes;
        }
        return d;
    }

    // The site embeds trailers from YouTube; only the video id is useful on a TV
    function trailer(postId) {
        return ajax('/engine/ajax/gettrailervideo.php', { id: postId }).then(function (json) {
            var m = String(json.code || '').match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/);
            if (!m) throw new Error('Трейлер не найден');
            return { videoId: m[1] };
        });
    }

    function details(url) {
        url = toPath(url);
        return getDoc(url).then(function (r) { return parseDetails(url, r.doc, r.html); });
    }

    /* ---------- streams ---------- */

    var TRASH = (function () {
        var c = ['@', '#', '!', '^', '$'], out = [];
        c.forEach(function (a) {
            c.forEach(function (b) {
                out.push(a + b);
                c.forEach(function (x) { out.push(a + b + x); });
            });
        });
        return out.map(function (s) { return btoa(s); });
    })();

    // Older site versions obfuscate the stream list: "#h" + base64 with junk inserted
    function decodeStreams(s) {
        if (typeof s !== 'string' || s.indexOf('#h') !== 0) return s;
        s = s.slice(2).split('//_//').join('');
        TRASH.forEach(function (t) { s = s.split(t).join(''); });
        while (s.length % 4) s += '=';
        try { return decodeURIComponent(escape(atob(s))); } catch (e) { return ''; }
    }

    function parseQualities(str) {
        str = decodeStreams(str);
        if (!str || typeof str !== 'string') return [];
        return str.split(/,(?=\[)/).map(function (part) {
            var m = part.match(/^\[([^\]]*)\]([\s\S]*)$/);
            if (!m) return null;
            var urls = m[2].split(/\s+or\s+/).map(function (u) { return u.trim(); }).filter(Boolean);
            var mp4 = urls.filter(function (u) { return !/\.m3u8$/.test(u); });
            var hls = urls.filter(function (u) { return /\.m3u8$/.test(u); });
            // The CDN serves every mp4 as HLS too. On the TV player progressive mp4 from it
            // takes 15-45 s to start (or never does) while HLS starts in ~3 s, so HLS goes first
            mp4.forEach(function (u) {
                var h = u + ':hls:manifest.m3u8';
                if (hls.indexOf(h) < 0) hls.push(h);
            });
            return {
                name: m[1].replace(/<[^>]*>/g, '').trim(),
                premium: /prem/i.test(m[1]),
                urls: hls.concat(mp4)
            };
        }).filter(function (q) { return q && q.urls.length; });
    }

    function parseSubs(str) {
        if (!str || typeof str !== 'string') return [];
        return str.split(/,(?=\[)/).map(function (part) {
            var m = part.match(/^\[([^\]]+)\](.+)$/);
            return m ? { name: m[1], url: m[2].trim() } : null;
        }).filter(Boolean);
    }

    function streamResult(json) {
        return {
            qualities: parseQualities(json.url),
            subs: parseSubs(json.subtitle),
            subDefault: json.subtitle_def || '',
            subLangs: json.subtitle_lns || {}
        };
    }

    function getMovie(id, tr) {
        return ajax('/ajax/get_cdn_series/', {
            id: id, translator_id: tr.id, is_camrip: tr.camrip, is_ads: tr.ads, is_director: tr.director,
            favs: session.favs, action: 'get_movie'
        }).then(streamResult);
    }

    function getStream(id, trId, season, episode) {
        return ajax('/ajax/get_cdn_series/', {
            id: id, translator_id: trId, season: season, episode: episode, favs: session.favs, action: 'get_stream'
        }).then(streamResult);
    }

    function getEpisodes(id, trId) {
        return ajax('/ajax/get_cdn_series/', {
            id: id, translator_id: trId, favs: session.favs, action: 'get_episodes'
        }).then(function (json) {
            var doc = new DOMParser().parseFromString(
                '<ul>' + (json.seasons || '') + '</ul>' + (json.episodes || ''), 'text/html');
            return parseEpisodeLists(doc);
        });
    }

    function sendSave(postId, trId, season, episode, time, duration) {
        if (!session.logged) return Promise.resolve();
        return ajax('/ajax/send_save/', {
            post_id: postId, translator_id: trId, season: season || 0, episode: episode || 0,
            current_time: Math.floor(time), duration: Math.floor(duration)
        }).catch(function () { /* progress sync is best effort */ });
    }

    function getText(url) {
        return request('GET', url);
    }

    /* ---------- account ---------- */

    function checkSession() {
        return getDoc('/').then(function () { return session; }, function (e) {
            if (e.auth) return session;
            throw e;
        });
    }

    function login(email, password) {
        return ajax('/ajax/login/', { login_name: email, login_password: password, login_not_save: 0 })
            .then(function (json) {
                if (!json.success) throw new Error(cleanMessage(json.message) || 'Не удалось войти');
                return checkSession();
            })
            .then(function (s) {
                if (!s.logged) throw new Error('Вход выполнен, но телевизор не сохранил сессию (cookie)');
                return s;
            });
    }

    function logout() {
        return request('GET', '/logout/').catch(function () {}).then(function () {
            session.logged = false;
            session.premium = false;
        });
    }

    return {
        session: session,
        store: store,
        mirror: mirror,
        setMirror: setMirror,
        toPath: toPath,
        postIdFromUrl: postIdFromUrl,
        listing: listing,
        search: search,
        continueList: continueList,
        removeSave: removeSave,
        createSave: createSave,
        toggleSaveWatched: toggleSaveWatched,
        toggleFavorite: toggleFavorite,
        addFavoriteCategory: addFavoriteCategory,
        favoriteCategories: favoriteCategories,
        favorites: favorites,
        details: details,
        trailer: trailer,
        person: person,
        getMovie: getMovie,
        getStream: getStream,
        getEpisodes: getEpisodes,
        sendSave: sendSave,
        getText: getText,
        checkSession: checkSession,
        login: login,
        logout: logout,
        parseQualities: parseQualities,
        parseSubs: parseSubs
    };
})();
