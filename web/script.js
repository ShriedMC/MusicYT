const localPlayer = document.getElementById('local-player');

// MusicYT is free software. This notice is asserted in several independent
// places (here, index.html, style.css, and app.py) on purpose - if you are
// looking at this because you are repackaging MusicYT to sell it: don't.
const FREE_NOTICE = 'MusicYT is free and will always be free. If you paid for this, you got scammed.';
function assertFreeNotice() {
    try {
        console.log('%c' + FREE_NOTICE, 'color:#1db954;font-weight:bold');
        const bn = document.getElementById('free-banner');
        if (bn) bn.textContent = FREE_NOTICE;
        const mn = document.getElementById('modal-free-notice');
        if (mn) mn.textContent = FREE_NOTICE;
        document.title = 'MusicYT Player';
    } catch (e) { /* never let this break the app */ }
}
document.addEventListener('DOMContentLoaded', assertFreeNotice);
assertFreeNotice();

let currentPlaylists = {};
let songToAdd = null;
let currentPlayingId = null;
let currentPlaylistView = null; // Name of playlist currently being viewed
let isShuffle = false;
let isRepeat = false;
let playNextQueue = []; // Queue for "Play Next" context menu feature
let apiRef = null;      // set on pywebviewready, used by persistence helpers

// ---- Persisted settings (volume / shuffle / repeat / last playlist) ----
const _settingTimers = {};
function saveSetting(key, value) {
    if (!apiRef || !apiRef.save_settings) return;
    clearTimeout(_settingTimers[key]);
    _settingTimers[key] = setTimeout(() => {
        const patch = {};
        patch[key] = value;
        apiRef.save_settings(patch);
    }, 250);
}

// ---- First-run downloader (Deno) status banner ----
function watchRuntime(api) {
    const banner = document.getElementById('runtime-banner');
    const text = document.getElementById('runtime-banner-text');
    if (!api.get_runtime_status) return;

    const poll = () => {
        api.get_runtime_status().then(st => {
            if (!st || st.state === 'ok' || st.state === 'checking') {
                banner.classList.add('hidden');
                if (!st || st.state !== 'checking') return;
            } else if (st.state === 'downloading') {
                banner.classList.remove('hidden', 'is-error');
                text.textContent = `Setting up the downloader… ${st.progress || 0}%`;
            } else if (st.state === 'error') {
                banner.classList.remove('hidden');
                banner.classList.add('is-error');
                text.textContent = st.detail || 'Downloader setup failed.';
                setTimeout(() => banner.classList.add('hidden'), 12000);
                return;
            }
            setTimeout(poll, 700);
        }).catch(() => {});
    };
    poll();
}

function restoreSettings(api) {
    if (!api.get_settings) return;
    api.get_settings().then(s => {
        s = s || {};

        if (typeof s.volume === 'number') {
            updateVolume(s.volume, false);
        }
        if (s.shuffle) {
            isShuffle = true;
            document.getElementById('btn-shuffle').style.color = 'var(--accent)';
            const pl = document.getElementById('playlist-shuffle-btn');
            if (pl) pl.style.color = 'var(--accent)';
        }
        if (s.repeat) {
            isRepeat = true;
            document.getElementById('btn-repeat').style.color = 'var(--accent)';
        }
        if (s.last_playlist) {
            api.get_playlists().then(playlists => {
                if (!playlists || !playlists[s.last_playlist]) return;
                document.querySelectorAll('.sidebar li, .playlist-item').forEach(el => el.classList.remove('active'));
                document.getElementById('view-home').classList.add('hidden');
                document.getElementById('view-playlist').classList.remove('hidden');
                renderPlaylistView(s.last_playlist, playlists[s.last_playlist], api);
            });
        }
    }).catch(() => {});
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// Ensure the UI matches player state
function syncPlayState() {
    const hasTrack = localPlayer.src !== "";
    const isPlaying = !localPlayer.paused && hasTrack;

    const playPauseBtn = document.getElementById('play-pause-btn');
    playPauseBtn.disabled = !hasTrack;
    playPauseBtn.querySelector('i').className = isPlaying ? 'ph-fill ph-pause-circle' : 'ph-fill ph-play-circle';

    const bigPlayBtn = document.querySelector('#playlist-play-btn i');
    if (bigPlayBtn) {
        bigPlayBtn.className = isPlaying ? 'ph-fill ph-pause' : 'ph-fill ph-play';
    }

    // Sync table rows
    document.querySelectorAll('.tracks-table tbody tr').forEach(row => {
        if (row.dataset.id === currentPlayingId) {
            if (isPlaying) {
                row.classList.add('track-playing');
                row.querySelector('.track-play-icon').className = 'ph-fill ph-pause track-play-icon';
            } else {
                row.classList.remove('track-playing');
                row.querySelector('.track-play-icon').className = 'ph-fill ph-play track-play-icon';
            }
        } else {
            row.classList.remove('track-playing');
            row.querySelector('.track-play-icon').className = 'ph-fill ph-play track-play-icon';
        }
    });
}

localPlayer.addEventListener('timeupdate', () => {
    const current = localPlayer.currentTime;
    const duration = localPlayer.duration;
    document.getElementById('time-current').textContent = formatTime(current);
    if (duration) document.getElementById('progress-fill').style.width = `${(current / duration) * 100}%`;
});
localPlayer.addEventListener('loadedmetadata', () => { document.getElementById('time-total').textContent = formatTime(localPlayer.duration); });
localPlayer.addEventListener('play', syncPlayState);
localPlayer.addEventListener('pause', syncPlayState);


window.addEventListener('pywebviewready', function() {
    const api = window.pywebview.api;
    apiRef = api;

    assertFreeNotice();
    watchRuntime(api);
    restoreSettings(api);

    // First-run notices: copyright acknowledgement + "MusicYT is free" (also
    // shown natively by app.py and permanently in the sidebar).
    api.check_first_launch().then(isFirst => {
        if (isFirst) document.getElementById('warning-modal').classList.remove('hidden');
    });
    if (api.free_notice) {
        api.free_notice().then(txt => { if (txt) { const m = document.getElementById('modal-free-notice'); if (m) m.textContent = txt; } });
    }
    document.getElementById('accept-warning-btn').addEventListener('click', () => {
        api.accept_warning().then(() => { document.getElementById('warning-modal').classList.add('hidden'); });
    });

    loadPlaylists(api);

    // Sidebar navigation
    document.getElementById('nav-home').addEventListener('click', () => {
        document.querySelectorAll('.sidebar li, .playlist-item').forEach(el => el.classList.remove('active'));
        document.getElementById('nav-home').classList.add('active');
        document.getElementById('view-home').classList.remove('hidden');
        document.getElementById('view-playlist').classList.add('hidden');
        currentPlaylistView = null;
        saveSetting('last_playlist', null);
        populateHome();
    });
    
    populateHome(); // Default view

    // Search Dropdown Logic
    const searchInput = document.getElementById('search-input');
    const searchDropdown = document.getElementById('search-dropdown');
    let searchTimeout;

    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim();
        if (query.length > 2) {
            searchDropdown.classList.remove('hidden');
            document.getElementById('search-dropdown-results').innerHTML = '';
            document.getElementById('search-dropdown-spinner').classList.remove('hidden');
            searchTimeout = setTimeout(() => { performSearch(query, api); }, 600);
        } else {
            searchDropdown.classList.add('hidden');
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-wrapper')) {
            searchDropdown.classList.add('hidden');
        }
    });

    // Modals
    setupModals(api);
});

function setupModals(api) {
    document.getElementById('create-playlist-btn').addEventListener('click', () => {
        document.getElementById('create-playlist-modal').classList.remove('hidden');
    });
    document.getElementById('cancel-create-playlist').addEventListener('click', () => {
        document.getElementById('create-playlist-modal').classList.add('hidden');
    });
    document.getElementById('confirm-create-playlist').addEventListener('click', () => {
        const name = document.getElementById('new-playlist-name').value.trim();
        if (name) {
            api.create_playlist(name).then(success => {
                if(success) loadPlaylists(api);
                document.getElementById('create-playlist-modal').classList.add('hidden');
                document.getElementById('new-playlist-name').value = '';
            });
        }
    });

    document.getElementById('cancel-add-playlist').addEventListener('click', () => {
        document.getElementById('add-to-playlist-modal').classList.add('hidden');
        songToAdd = null;
    });

    // Bulk Import Modal
    document.getElementById('playlist-bulk-import-btn').addEventListener('click', () => {
        document.getElementById('bulk-import-modal').classList.remove('hidden');
        document.getElementById('bulk-import-textarea').value = '';
        document.getElementById('bulk-import-status').classList.add('hidden');
    });
    document.getElementById('cancel-bulk-import').addEventListener('click', () => {
        document.getElementById('bulk-import-modal').classList.add('hidden');
    });
    document.getElementById('confirm-bulk-import').addEventListener('click', () => {
        const text = document.getElementById('bulk-import-textarea').value;
        const lines = text.split('\n').filter(l => l.trim().length > 0);
        if (lines.length === 0) return;

        document.getElementById('bulk-import-status').classList.remove('hidden');
        const btn = document.getElementById('confirm-bulk-import');
        btn.disabled = true;

        api.bulk_import(currentPlaylistView, lines).then(added => {
            document.getElementById('bulk-import-status').classList.add('hidden');
            document.getElementById('bulk-import-modal').classList.add('hidden');
            btn.disabled = false;
            // Reload playlist view
            api.get_playlists().then(playlists => {
                currentPlaylists = playlists;
                if(currentPlaylistView) renderPlaylistView(currentPlaylistView, playlists[currentPlaylistView], api);
            });
            alert(`Successfully added ${added} track(s) to ${currentPlaylistView}.`);
        }).catch(err => {
            document.getElementById('bulk-import-status').classList.add('hidden');
            btn.disabled = false;
            alert('An error occurred during import.');
        });
    });
}

function loadPlaylists(api) {
    api.get_playlists().then(playlists => {
        currentPlaylists = playlists;
        const container = document.getElementById('sidebar-playlists');
        container.innerHTML = '';
        Object.keys(playlists).forEach(plName => {
            const el = document.createElement('div');
            el.className = 'playlist-item';
            el.textContent = plName;
            el.addEventListener('click', () => {
                document.querySelectorAll('.sidebar li, .playlist-item').forEach(el => el.classList.remove('active'));
                el.classList.add('active');
                
                document.getElementById('view-home').classList.add('hidden');
                document.getElementById('view-playlist').classList.remove('hidden');
                renderPlaylistView(plName, playlists[plName], api);
            });
            container.appendChild(el);
        });

        // Refresh the Home cards if that view is what's on screen
        if (!document.getElementById('view-home').classList.contains('hidden')) {
            populateHome();
        }
    });
}

function renderPlaylistView(name, songs, api) {
    currentPlaylistView = name;
    saveSetting('last_playlist', name);
    document.getElementById('playlist-title').textContent = name;
    
    // Trigger background download sync
    api.background_sync_playlist(name);
    
    // Duration math
    let totalSec = 0;
    songs.forEach(s => { if(s.duration) totalSec += s.duration; });
    const m = Math.floor(totalSec / 60);
    document.getElementById('playlist-stats').textContent = `${songs.length} songs, ${m} min`;

    const tbody = document.getElementById('playlist-table-body');
    tbody.innerHTML = '';

    if (songs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding: 40px 0;">This playlist is empty. Use Search or Bulk Import to add tracks.</td></tr>`;
        return;
    }

    songs.forEach((item, index) => {
        const tr = document.createElement('tr');
        tr.dataset.id = item.id;
        tr.innerHTML = `
            <td class="track-num-cell">
                <span class="track-num">${index + 1}</span>
                <i class="ph-fill ph-play track-play-icon"></i>
            </td>
            <td class="title-col">
                <img src="${item.thumbnail}" alt="">
                <div class="title-info">
                    <div class="track-name">${item.title}</div>
                    <div class="track-artist">${item.channel}</div>
                </div>
            </td>
            <td>Just now</td>
            <td class="action-col">
                <button class="add-btn" title="Add to another playlist"><i class="ph ph-plus-circle"></i></button>
                <button class="remove-btn add-btn" title="Remove from playlist" style="margin-left: 8px;"><i class="ph ph-trash"></i></button>
                <span style="display:inline-block; width: 40px; text-align:right;">${formatTime(item.duration)}</span>
            </td>
        `;

        tr.addEventListener('click', (e) => {
            // If they clicked the add btn, don't play
            if(e.target.closest('.add-btn')) return;
            
            if (currentPlayingId === item.id) {
                localPlayer.paused ? localPlayer.play() : localPlayer.pause();
            } else {
                playSong(item, api);
            }
        });

        tr.querySelector('.add-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openAddToPlaylistModal(item, api);
        });

        tr.querySelector('.remove-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            api.remove_from_playlist(currentPlaylistView, item.id).then(success => {
                if (success) {
                    api.get_playlists().then(playlists => {
                        currentPlaylists = playlists;
                        renderPlaylistView(currentPlaylistView, playlists[currentPlaylistView], api);
                    });
                }
            });
        });

        tr.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const ctxMenu = document.getElementById('context-menu');
            ctxMenu.style.left = `${e.pageX}px`;
            ctxMenu.style.top = `${e.pageY}px`;
            ctxMenu.classList.remove('hidden');
            
            // Setup Context Menu Actions
            document.getElementById('ctx-play-next').onclick = () => {
                playNextQueue.push(item);
                ctxMenu.classList.add('hidden');
            };
            document.getElementById('ctx-remove').onclick = () => {
                api.remove_from_playlist(currentPlaylistView, item.id).then(success => {
                    if (success) {
                        api.get_playlists().then(playlists => {
                            currentPlaylists = playlists;
                            renderPlaylistView(currentPlaylistView, playlists[currentPlaylistView], api);
                        });
                    }
                });
                ctxMenu.classList.add('hidden');
            };
        });

        tbody.appendChild(tr);
    });
    
    syncPlayState();
}

// Hide Context Menu on click outside
document.addEventListener('click', (e) => {
    if(!e.target.closest('.context-menu')) {
        document.getElementById('context-menu').classList.add('hidden');
    }
});

function performSearch(query, api) {
    api.search_youtube(query).then(results => {
        document.getElementById('search-dropdown-spinner').classList.add('hidden');
        const container = document.getElementById('search-dropdown-results');
        container.innerHTML = '';

        if (results.length === 0) {
            container.innerHTML = `<p style="padding: 16px; color: var(--text-subdued);">No results found.</p>`;
            return;
        }

        results.forEach(item => {
            const el = document.createElement('div');
            el.className = 'dropdown-item';
            el.innerHTML = `
                <img src="${item.thumbnail}" alt="">
                <div class="dropdown-info">
                    <div class="dropdown-title">${item.title}</div>
                    <div class="dropdown-artist">${item.channel}</div>
                </div>
                <div class="dropdown-action" title="Add to Playlist">
                    <i class="ph ph-plus"></i>
                </div>
            `;
            
            el.addEventListener('click', (e) => {
                if(e.target.closest('.dropdown-action')) return;
                document.getElementById('search-dropdown').classList.add('hidden');
                playSong(item, api);
            });

            el.querySelector('.dropdown-action').addEventListener('click', (e) => {
                e.stopPropagation();
                document.getElementById('search-dropdown').classList.add('hidden');
                openAddToPlaylistModal(item, api);
            });

            container.appendChild(el);
        });
    });
}

function openAddToPlaylistModal(item, api) {
    songToAdd = item;
    const modal = document.getElementById('add-to-playlist-modal');
    const list = document.getElementById('modal-playlist-list');
    list.innerHTML = '';
    
    api.get_playlists().then(playlists => {
        if (Object.keys(playlists).length === 0) {
            list.innerHTML = `<p style="color: var(--text-subdued)">No playlists available. Create one first!</p>`;
        } else {
            Object.keys(playlists).forEach(plName => {
                const itemEl = document.createElement('div');
                itemEl.className = 'playlist-item';
                itemEl.textContent = plName;
                itemEl.addEventListener('click', () => {
                    api.add_to_playlist(plName, songToAdd).then(success => {
                        if(success) loadPlaylists(api);
                        modal.classList.add('hidden');
                    });
                });
                list.appendChild(itemEl);
            });
        }
        modal.classList.remove('hidden');
    });
}

function playSong(item, api) {
    currentPlayingId = item.id;
    document.getElementById('np-title').textContent = item.title;
    document.getElementById('np-artist').textContent = item.channel;
    const img = document.getElementById('np-image');
    img.src = item.thumbnail; img.classList.remove('hidden');
    
    // Dynamic Background Color Extraction
    img.crossOrigin = "Anonymous";
    img.onload = () => {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 1; canvas.height = 1;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            document.documentElement.style.setProperty('--dynamic-color', `rgb(${r}, ${g}, ${b})`);
        } catch (e) {
            // Ignore cross-origin errors
        }
    };
    
    document.getElementById('global-loading').classList.remove('hidden');
    document.getElementById('spinner-text').textContent = 'Downloading MP3...';

    api.download_audio(item.id).then(localUrl => {
        document.getElementById('global-loading').classList.add('hidden');
        if (localUrl) {
            localPlayer.src = localUrl;
            localPlayer.play();
            // Trigger OS Notification
            if (api.show_notification) {
                api.show_notification(item.title, item.channel, item.thumbnail);
            }
        } else {
            alert("Failed to download audio track.");
        }
    }).catch(err => {
        document.getElementById('global-loading').classList.add('hidden');
        alert("An error occurred during download.");
    });
}

// UI Controls Bottom Bar
document.getElementById('play-pause-btn').addEventListener('click', () => {
    if (!localPlayer.src) return;
    localPlayer.paused ? localPlayer.play() : localPlayer.pause();
});

document.getElementById('playlist-play-btn').addEventListener('click', () => {
    if (!currentPlaylistView) return;
    const songs = currentPlaylists[currentPlaylistView];
    if (!songs || songs.length === 0) return;
    
    let isCurrentSongInPlaylist = false;
    for (let i = 0; i < songs.length; i++) {
        if (songs[i].id === currentPlayingId) {
            isCurrentSongInPlaylist = true;
            break;
        }
    }

    if (isCurrentSongInPlaylist) {
        localPlayer.paused ? localPlayer.play() : localPlayer.pause();
    } else {
        playSong(songs[0], window.pywebview.api);
    }
});

function getNextSong(offset = 1) {
    if (offset === 1 && playNextQueue.length > 0) {
        return playNextQueue.shift();
    }

    if (!currentPlaylistView || !currentPlayingId) return null;
    const songs = currentPlaylists[currentPlaylistView];
    if (!songs || songs.length === 0) return null;
    
    // If repeat is on and it's an auto-advance (offset=1 from ended), just return the same song
    if (isRepeat && offset === 1 && localPlayer.currentTime >= localPlayer.duration - 1) {
        // We handle repeat differently in ended event to just seek to 0, but if we get here:
        return null; // Let the ended event handle repeat
    }

    if (isShuffle) {
        // Pick a random song that isn't current
        if (songs.length === 1) return songs[0];
        let randIdx;
        do { randIdx = Math.floor(Math.random() * songs.length); } 
        while (songs[randIdx].id === currentPlayingId);
        return songs[randIdx];
    }

    let idx = -1;
    for(let i=0; i<songs.length; i++) {
        if (songs[i].id === currentPlayingId) {
            idx = i;
            break;
        }
    }
    if (idx !== -1) {
        const nextIdx = (idx + offset + songs.length) % songs.length;
        return songs[nextIdx];
    }
    return null;
}

document.getElementById('btn-skip-back').addEventListener('click', () => {
    const prev = getNextSong(-1);
    if (prev) playSong(prev, window.pywebview.api);
});

document.getElementById('btn-skip-forward').addEventListener('click', () => {
    const next = getNextSong(1);
    if (next) playSong(next, window.pywebview.api);
});

document.getElementById('btn-shuffle').addEventListener('click', () => {
    isShuffle = !isShuffle;
    document.getElementById('btn-shuffle').style.color = isShuffle ? 'var(--accent)' : 'var(--text-subdued)';
    const plShuffleBtn = document.getElementById('playlist-shuffle-btn');
    if(plShuffleBtn) plShuffleBtn.style.color = isShuffle ? 'var(--accent)' : 'var(--text-subdued)';
    saveSetting('shuffle', isShuffle);
});

document.getElementById('playlist-shuffle-btn').addEventListener('click', () => {
    isShuffle = !isShuffle;
    document.getElementById('btn-shuffle').style.color = isShuffle ? 'var(--accent)' : 'var(--text-subdued)';
    document.getElementById('playlist-shuffle-btn').style.color = isShuffle ? 'var(--accent)' : 'var(--text-subdued)';
    saveSetting('shuffle', isShuffle);

    // Play a random song if shuffle is turned on
    if (isShuffle && currentPlaylistView && currentPlaylists[currentPlaylistView].length > 0) {
        const songs = currentPlaylists[currentPlaylistView];
        const randIdx = Math.floor(Math.random() * songs.length);
        playSong(songs[randIdx], window.pywebview.api);
    }
});

document.getElementById('btn-repeat').addEventListener('click', () => {
    isRepeat = !isRepeat;
    document.getElementById('btn-repeat').style.color = isRepeat ? 'var(--accent)' : 'var(--text-subdued)';
    saveSetting('repeat', isRepeat);
});

localPlayer.addEventListener('ended', () => {
    syncPlayState();
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('time-current').textContent = '0:00';
    
    if (isRepeat) {
        localPlayer.currentTime = 0;
        localPlayer.play();
        return;
    }
    
    // Autoplay next song in playlist
    const next = getNextSong(1);
    if (next) playSong(next, window.pywebview.api);
});

// Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    switch(e.code) {
        case 'Space':
            e.preventDefault();
            if (localPlayer.src) {
                localPlayer.paused ? localPlayer.play() : localPlayer.pause();
            }
            break;
        case 'ArrowRight':
            e.preventDefault();
            if (localPlayer.src) localPlayer.currentTime = Math.min(localPlayer.duration, localPlayer.currentTime + 10);
            break;
        case 'ArrowLeft':
            e.preventDefault();
            if (localPlayer.src) localPlayer.currentTime = Math.max(0, localPlayer.currentTime - 10);
            break;
        case 'ArrowUp':
            e.preventDefault();
            updateVolume(Math.min(1, localPlayer.volume + 0.1));
            break;
        case 'ArrowDown':
            e.preventDefault();
            updateVolume(Math.max(0, localPlayer.volume - 0.1));
            break;
        case 'KeyM':
            e.preventDefault();
            toggleMute();
            break;
    }
});

const progressBarWrapper = document.querySelector('.progress-bar-wrapper');
progressBarWrapper.addEventListener('click', (e) => {
    if (!localPlayer.src || !localPlayer.duration) return;
    const rect = progressBarWrapper.getBoundingClientRect();
    localPlayer.currentTime = ((e.clientX - rect.left) / rect.width) * localPlayer.duration;
});

let previousVolume = 1;
function updateVolume(vol, persist = true) {
    document.getElementById('volume-fill').style.width = `${vol * 100}%`;
    localPlayer.volume = vol;
    if (persist) saveSetting('volume', vol);

    const muteIcon = document.getElementById('mute-btn');
    if (vol === 0) {
        muteIcon.className = 'ph ph-speaker-x';
    } else if (vol < 0.5) {
        muteIcon.className = 'ph ph-speaker-low';
    } else {
        muteIcon.className = 'ph ph-speaker-high';
    }
}

function toggleMute() {
    if (localPlayer.volume > 0) {
        previousVolume = localPlayer.volume;
        updateVolume(0);
    } else {
        updateVolume(previousVolume || 1);
    }
}

const volumeBarWrapper = document.querySelector('.volume-bar-wrapper');
volumeBarWrapper.addEventListener('click', (e) => {
    const rect = volumeBarWrapper.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    updateVolume(pos);
});

// Scroll to adjust volume
volumeBarWrapper.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    updateVolume(Math.max(0, Math.min(1, localPlayer.volume + delta)));
});

document.getElementById('mute-btn').addEventListener('click', toggleMute);

document.getElementById('mini-player-btn').addEventListener('click', () => {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.toggle_mini_player) {
        window.pywebview.api.toggle_mini_player();
    }
});

function populateHome() {
    const grid = document.getElementById('home-recommendations');
    grid.innerHTML = '';

    const names = Object.keys(currentPlaylists || {});
    if (names.length > 0) {
        names.forEach((name, i) => {
            const count = currentPlaylists[name].length;
            const card = document.createElement('div');
            card.className = 'category-card';
            card.innerHTML = `
                <div class="category-art" style="--h:${(i * 67) % 360}"></div>
                <h3>${name}</h3>
                <p>${count} track${count === 1 ? '' : 's'}</p>
            `;
            card.addEventListener('click', () => {
                document.querySelectorAll('.sidebar li, .playlist-item').forEach(el => el.classList.remove('active'));
                document.getElementById('view-home').classList.add('hidden');
                document.getElementById('view-playlist').classList.remove('hidden');
                renderPlaylistView(name, currentPlaylists[name], apiRef);
            });
            grid.appendChild(card);
        });
        return;
    }

    const tips = [
        {h: 'Search', p: 'Type in the search bar to find and play any track.'},
        {h: 'Playlists', p: 'Hit + in the sidebar to make your first playlist.'},
        {h: 'Offline', p: 'Opening a playlist downloads its tracks for offline play.'}
    ];
    tips.forEach((t, i) => {
        const card = document.createElement('div');
        card.className = 'category-card';
        card.innerHTML = `<div class="category-art" style="--h:${i * 90}"></div><h3>${t.h}</h3><p>${t.p}</p>`;
        grid.appendChild(card);
    });
}
