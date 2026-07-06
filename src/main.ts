import { Plugin } from 'obsidian';
import { ThumbnailFixManager } from './thumbnailFix';

interface PluginSettings {
    doubleTapEnabled: boolean;
    doubleTapSeconds: number;
    scrubEnabled: boolean;
    scrubSensitivity: number;
    volumeEnabled: boolean;
    fullscreenControlsEnabled: boolean;
    blockInputInFullscreen: boolean;
    longPressEnabled: boolean;
    longPressSpeed: number;
    longPressDelay: number;
    thumbnailFixEnabled: boolean;
    thumbnailFixMaxConcurrent: number;
    thumbnailFixMaxRetries: number;
    thumbnailFixRetryDelayMs: number;
}

const DEFAULT_SETTINGS: PluginSettings = {
    doubleTapEnabled: true,
    doubleTapSeconds: 10,
    scrubEnabled: true,
    scrubSensitivity: 30,
    volumeEnabled: true,
    fullscreenControlsEnabled: true,
    blockInputInFullscreen: true,
    longPressEnabled: true,
    longPressSpeed: 2,
    longPressDelay: 400,
    thumbnailFixEnabled: false,
    thumbnailFixMaxConcurrent: 3,
    thumbnailFixMaxRetries: 3,
    thumbnailFixRetryDelayMs: 800,
};

export default class VideoControlsEnhancer extends Plugin {
    settings!: PluginSettings;
    private observer: MutationObserver | null = null;
    private thumbnailFix: ThumbnailFixManager | null = null;
    /**
     * Lets other modules (currently the thumbnail fix) swap out the
     * underlying <video> element for a fresh one while keeping all touch
     * control behavior (which lives on the wrapper) working, since the
     * enhanceVideo() closures below always refer to whatever element is
     * currently assigned, not a fixed reference.
     */
    private videoReplaceHandlers = new WeakMap<HTMLVideoElement, (newVideo: HTMLVideoElement) => void>();

    async onload() {
        await this.loadSettings();
        this.applyFsControlsClass();

        this.thumbnailFix = new ThumbnailFixManager(this);
        this.register(() => this.thumbnailFix?.destroy());

        const processVideo = (video: HTMLVideoElement) => {
            this.enhanceVideo(video);
            this.thumbnailFix?.handleVideo(video);
        };

        this.registerMarkdownPostProcessor((element) => {
            const videos = element.querySelectorAll<HTMLVideoElement>('video');
            for (let i = 0; i < videos.length; i++) {
                const video = videos[i];
                if (video) processVideo(video);
            }
        });

        this.observer = new MutationObserver((mutations) => {
            for (let mi = 0; mi < mutations.length; mi++) {
                const m = mutations[mi];
                if (!m) continue;
                for (let ni = 0; ni < m.addedNodes.length; ni++) {
                    const node = m.addedNodes[ni];
                    if (node instanceof HTMLElement) {
                        if (node.tagName === 'VIDEO') {
                            processVideo(node as HTMLVideoElement);
                        }
                        const videos = node.querySelectorAll<HTMLVideoElement>('video');
                        for (let i = 0; i < videos.length; i++) {
                            const video = videos[i];
                            if (video) processVideo(video);
                        }
                    }
                }
            }
        });

        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
        this.register(() => this.observer?.disconnect());

        this.addSettingTab(new VideoControlsSettingTab(this.app, this));
    }

    async loadSettings() {
        const data = (await this.loadData()) as Partial<PluginSettings>;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.applyFsControlsClass();
    }

    applyFsControlsClass() {
        document.body.classList.toggle('vce-fs-controls', this.settings.fullscreenControlsEnabled);
    }

    /**
     * Replaces a video element that is currently managed by enhanceVideo()
     * with a fresh one (e.g. because the thumbnail fix needs a brand new
     * element to get a clean decoder on Android). Returns true if the
     * swap was performed.
     */
    replaceVideoElement(oldVideo: HTMLVideoElement, newVideo: HTMLVideoElement): boolean {
        const handler = this.videoReplaceHandlers.get(oldVideo);
        if (!handler) return false;
        handler(newVideo);
        return true;
    }

    enhanceVideo(video: HTMLVideoElement) {
        if (video.hasAttribute('data-vce')) return;
        video.setAttribute('data-vce', 'true');

        const wrapper = document.createElement('div');
        wrapper.className = 'video-controls-enhancer-wrapper';
        video.parentNode?.insertBefore(wrapper, video);
        wrapper.appendChild(video);

        const replaceVideoElement = (newVideo: HTMLVideoElement) => {
            newVideo.setAttribute('data-vce', 'true');
            wrapper.replaceChild(newVideo, video);
            this.videoReplaceHandlers.delete(video);
            video = newVideo;
            this.videoReplaceHandlers.set(video, replaceVideoElement);
        };
        this.videoReplaceHandlers.set(video, replaceVideoElement);

        // When the video is fullscreen, events still bubble through the normal
        // DOM tree (which includes the canvas). Stop propagation of input events
        // on the wrapper so gestures don't reach the canvas behind it.
        const blockedEvents = [
            'mousedown', 'mousemove', 'mouseup', 'mouseleave',
            'touchstart', 'touchmove', 'touchend', 'touchcancel',
            'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
            'wheel', 'click', 'dblclick', 'dragstart', 'contextmenu',
        ];
        const inputBlocker = (e: Event) => { e.stopPropagation(); };
        const attachInputBlockers = () => {
            for (const type of blockedEvents) {
                wrapper.addEventListener(type, inputBlocker, { capture: false });
            }
        };
        const detachInputBlockers = () => {
            for (const type of blockedEvents) {
                wrapper.removeEventListener(type, inputBlocker);
            }
        };

        const onFsChange = () => {
            const fs = document.fullscreenElement;
            const isFs = fs === video || fs === wrapper;
            if (isFs && this.settings.blockInputInFullscreen) {
                attachInputBlockers();
            } else {
                detachInputBlockers();
            }
        };
        document.addEventListener('fullscreenchange', onFsChange);
        document.addEventListener('webkitfullscreenchange', onFsChange);
        this.register(() => {
            document.removeEventListener('fullscreenchange', onFsChange);
            document.removeEventListener('webkitfullscreenchange', onFsChange);
            detachInputBlockers();
        });

        let lastTapTime = 0;
        let dragMode: 'none' | 'scrub' | 'volume' = 'none';
        let dragStartX = 0;
        let dragStartY = 0;
        let dragStartTime = 0;
        let dragStartVolume = 0;
        let isDragging = false;
        let justDragged = false;
        let overlayEl: HTMLDivElement | null = null;
        let overlayTimer: number | null = null;
        let longPressTimer: number | null = null;
        let isLongPressing = false;
        let justLongPressed = false;

        const formatTime = (s: number): string => {
            if (!isFinite(s) || s <= 0) return '0:00';
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return `${m}:${sec.toString().padStart(2, '0')}`;
        };

        const buildVolumeLabel = (pct: number): HTMLElement => {
            const wrap = document.createElement('span');
            wrap.className = 'vce-vol-label';
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('width', '32');
            svg.setAttribute('height', '32');
            svg.setAttribute('aria-hidden', 'true');
            const makeFill = (d: string, opacity = 1) => {
                const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                p.setAttribute('d', d);
                p.setAttribute('fill', 'currentColor');
                p.setAttribute('opacity', String(opacity));
                return p;
            };
            const makeStroke = (d: string) => {
                const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                p.setAttribute('d', d);
                p.setAttribute('fill', 'none');
                p.setAttribute('stroke', 'currentColor');
                p.setAttribute('stroke-width', '2');
                p.setAttribute('stroke-linecap', 'round');
                return p;
            };
            svg.appendChild(makeFill('M3 10v4a1 1 0 0 0 1 1h2l4 4V5L6 9H4a1 1 0 0 0-1 1z'));
            if (pct === 0) {
                svg.appendChild(makeStroke('M16 9l5 5M21 9l-5 5'));
            } else {
                if (pct > 0) svg.appendChild(makeStroke('M13 8a5 5 0 0 1 0 8'));
                if (pct > 50) svg.appendChild(makeStroke('M15.5 5.5a9 9 0 0 1 0 13'));
            }
            wrap.appendChild(svg);
            wrap.appendChild(document.createTextNode(` ${pct}%`));
            return wrap;
        };

        const supportsPopover = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;

        const showOverlay = (x: number, y: number, content: string | HTMLElement) => {
            if (overlayTimer) { window.clearTimeout(overlayTimer); overlayTimer = null; }
            if (!overlayEl) {
                overlayEl = document.createElement('div');
                overlayEl.className = 'vce-overlay';
                if (supportsPopover) {
                    overlayEl.popover = 'manual';
                }
                document.body.appendChild(overlayEl);
            }
            if (supportsPopover && !overlayEl.matches(':popover-open')) {
                try { overlayEl.showPopover(); } catch { /* ignore */ }
            }
            overlayEl.classList.remove('vce-overlay-fade');
            overlayEl.replaceChildren(typeof content === 'string' ? document.createTextNode(content) : content);
            overlayEl.style.left = `${x}px`;
            overlayEl.style.top = `${y - 60}px`;
            overlayTimer = window.setTimeout(() => {
                overlayEl?.classList.add('vce-overlay-fade');
                overlayTimer = window.setTimeout(() => {
                    if (overlayEl?.hidePopover) {
                        try { overlayEl.hidePopover(); } catch { /* ignore */ }
                    }
                    overlayEl?.remove();
                    overlayEl = null;
                    overlayTimer = null;
                }, 400);
            }, 400);
        };

        const fadeOverlay = () => {
            if (overlayTimer) { window.clearTimeout(overlayTimer); overlayTimer = null; }
            if (overlayEl) {
                overlayEl.classList.add('vce-overlay-fade');
                overlayTimer = window.setTimeout(() => {
                    if (overlayEl?.hidePopover) {
                        try { overlayEl.hidePopover(); } catch { /* ignore */ }
                    }
                    overlayEl?.remove();
                    overlayEl = null;
                    overlayTimer = null;
                }, 400);
            }
        };

        const tryDoubleTap = (clientX: number, clientY: number): boolean => {
            if (!this.settings.doubleTapEnabled) return false;
            const now = Date.now();
            if (now - lastTapTime < 400) {
                const rect = getVideoRect();
                const isRightSide = clientX > rect.left + rect.width / 2;
                const direction = isRightSide ? 1 : -1;
                const seconds = this.settings.doubleTapSeconds;
                video.currentTime = Math.max(0, Math.min(
                    video.duration,
                    video.currentTime + direction * seconds
                ));
                const sign = direction > 0 ? '+' : '-';
                showOverlay(clientX, clientY, `${sign}${seconds}s`);
                lastTapTime = 0;
                return true;
            }
            lastTapTime = now;
            return false;
        };

        const beginDrag = (x: number, y: number) => {
            if (!this.settings.scrubEnabled && !this.settings.volumeEnabled) return;
            dragMode = 'none';
            dragStartX = x;
            dragStartY = y;
            dragStartTime = video.currentTime;
            dragStartVolume = video.volume;
            isDragging = false;
        };

        const updateDrag = (clientX: number, clientY: number) => {
            if (isLongPressing) return;
            const deltaX = clientX - dragStartX;
            const deltaY = clientY - dragStartY;

            if (dragMode === 'none') {
                if (Math.abs(deltaX) < 5 && Math.abs(deltaY) < 5) return;
                cancelLongPressTimer();
                const preferScrub = Math.abs(deltaX) >= Math.abs(deltaY);
                if (preferScrub && this.settings.scrubEnabled) {
                    dragMode = 'scrub';
                } else if (!preferScrub && this.settings.volumeEnabled) {
                    dragMode = 'volume';
                } else if (preferScrub && this.settings.volumeEnabled) {
                    dragMode = 'volume';
                } else if (!preferScrub && this.settings.scrubEnabled) {
                    dragMode = 'scrub';
                }
                if (dragMode === 'none') return;
            }

            if (dragMode === 'scrub') {
                isDragging = true;
                justDragged = true;
                const rect = getVideoRect();
                const sensitivity = this.settings.scrubSensitivity / 100;
                const timeChange = (deltaX / rect.width) * video.duration * sensitivity;
                const newTime = Math.max(0, Math.min(video.duration, dragStartTime + timeChange));
                video.currentTime = newTime;
                showOverlay(clientX, clientY, formatTime(newTime));
            } else {
                isDragging = true;
                justDragged = true;
                const rect = getVideoRect();
                const newVolume = Math.max(0, Math.min(1, dragStartVolume - (deltaY / rect.height) * 2));
                video.volume = newVolume;
                const pct = Math.round(newVolume * 100);
                showOverlay(clientX, clientY, buildVolumeLabel(pct));
            }
        };

        const endDrag = () => {
            if (isDragging) {
                lastTapTime = 0;
                fadeOverlay();
            }
            dragMode = 'none';
            isDragging = false;
        };

        const startLongPressTimer = (x: number, y: number) => {
            if (!this.settings.longPressEnabled) return;
            cancelLongPressTimer();
            longPressTimer = window.setTimeout(() => {
                longPressTimer = null;
                if (dragMode === 'none' && !isDragging) {
                    isLongPressing = true;
                    video.playbackRate = this.settings.longPressSpeed;
                    showOverlay(x, y, `${this.settings.longPressSpeed}x`);
                }
            }, this.settings.longPressDelay);
        };

        const cancelLongPressTimer = () => {
            if (longPressTimer) { window.clearTimeout(longPressTimer); longPressTimer = null; }
        };

        const endLongPress = () => {
            cancelLongPressTimer();
            if (isLongPressing) {
                video.playbackRate = 1;
                isLongPressing = false;
                justLongPressed = true;
                fadeOverlay();
            }
        };

        const isInControls = (clientY: number): boolean => {
            const rect = getVideoRect();
            return (clientY - rect.top) > rect.height - 50;
        };

        const getVideoRect = () => {
            if (document.fullscreenElement === video || document.fullscreenElement === wrapper) {
                return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
            }
            return wrapper.getBoundingClientRect();
        };

        const togglePlayback = () => {
            if (video.paused) { void video.play(); } else { video.pause(); }
        };

        wrapper.addEventListener('mousedown', (e: MouseEvent) => {
            if (isInControls(e.clientY)) return;
            if (tryDoubleTap(e.clientX, e.clientY)) return;
            beginDrag(e.clientX, e.clientY);
            startLongPressTimer(e.clientX, e.clientY);
        });

        wrapper.addEventListener('mousemove', (e: MouseEvent) => {
            if (e.buttons !== 1) return;
            updateDrag(e.clientX, e.clientY);
        });

        wrapper.addEventListener('mouseup', () => {
            endDrag();
            endLongPress();
        });
        wrapper.addEventListener('mouseleave', () => {
            if (isDragging) fadeOverlay();
            dragMode = 'none';
            isDragging = false;
            endLongPress();
        });

        wrapper.addEventListener('click', (e: MouseEvent) => {
            if (isInControls(e.clientY)) return;
            if (justDragged || justLongPressed) {
                justDragged = false;
                justLongPressed = false;
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            e.stopPropagation();
            e.preventDefault();
            togglePlayback();
        }, true);

        wrapper.addEventListener('touchstart', (e: TouchEvent) => {
            const t = e.touches[0];
            if (!t) return;
            if (isInControls(t.clientY)) return;
            if (tryDoubleTap(t.clientX, t.clientY)) {
                e.preventDefault();
                return;
            }
            beginDrag(t.clientX, t.clientY);
            startLongPressTimer(t.clientX, t.clientY);
        }, { passive: false });

        wrapper.addEventListener('touchmove', (e: TouchEvent) => {
            const t = e.touches[0];
            if (!t) return;
            if (isLongPressing) {
                e.preventDefault();
                return;
            }
            updateDrag(t.clientX, t.clientY);
        }, { passive: false });

        wrapper.addEventListener('touchend', () => {
            endDrag();
            endLongPress();
        });
    }
}

import { App, PluginSettingTab, SettingGroup } from 'obsidian';

class VideoControlsSettingTab extends PluginSettingTab {
    plugin: VideoControlsEnhancer;

    constructor(app: App, plugin: VideoControlsEnhancer) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new SettingGroup(containerEl)
            .setHeading('Double tap')
            .addSetting(setting => {
                setting
                    .setName('Enable double tap')
                    .addToggle(toggle => {
                        toggle.setValue(this.plugin.settings.doubleTapEnabled)
                            .onChange(async (value) => {
                                this.plugin.settings.doubleTapEnabled = value;
                                await this.plugin.saveSettings();
                            });
                    });
            })
            .addSetting(setting => {
                setting
                    .setName('Jump seconds')
                    .setDesc('Amount of seconds to jump forward or backward.')
                    .addSlider(slider => {
                        slider.setLimits(1, 30, 1)
                            .setValue(this.plugin.settings.doubleTapSeconds)
                            .setDynamicTooltip()
                            .onChange(async (value) => {
                                this.plugin.settings.doubleTapSeconds = value;
                                await this.plugin.saveSettings();
                            });
                    });
            });

        new SettingGroup(containerEl)
            .setHeading('Scrub (horizontal drag)')
            .addSetting(setting => {
                setting
                    .setName('Enable scrubbing')
                    .addToggle(toggle => {
                        toggle.setValue(this.plugin.settings.scrubEnabled)
                            .onChange(async (value) => {
                                this.plugin.settings.scrubEnabled = value;
                                await this.plugin.saveSettings();
                            });
                    });
            })
            .addSetting(setting => {
                setting
                    .setName('Scrub sensitivity')
                    .setDesc('How much of the video is scrubbed when dragging across the full width. Lower = finer scrubbing.')
                    .addSlider(slider => {
                        slider.setLimits(10, 100, 5)
                            .setValue(this.plugin.settings.scrubSensitivity)
                            .setDynamicTooltip()
                            .onChange(async (value) => {
                                this.plugin.settings.scrubSensitivity = value;
                                await this.plugin.saveSettings();
                            });
                    });
            });

        new SettingGroup(containerEl)
            .setHeading('Volume (vertical drag)')
            .addSetting(setting => {
                setting
                    .setName('Enable volume control')
                    .addToggle(toggle => {
                        toggle.setValue(this.plugin.settings.volumeEnabled)
                            .onChange(async (value) => {
                                this.plugin.settings.volumeEnabled = value;
                                await this.plugin.saveSettings();
                            });
                    });
            });

        new SettingGroup(containerEl)
            .setHeading('Long press (fast forward)')
            .addSetting(setting => {
                setting
                    .setName('Enable long press fast forward')
                    .setDesc('Press and hold without dragging to fast forward at increased speed. Release to return to normal speed.')
                    .addToggle(toggle => {
                        toggle.setValue(this.plugin.settings.longPressEnabled)
                            .onChange(async (value) => {
                                this.plugin.settings.longPressEnabled = value;
                                await this.plugin.saveSettings();
                            });
                    });
            })
            .addSetting(setting => {
                setting
                    .setName('Fast forward speed')
                    .setDesc('Playback speed while long pressing.')
                    .addSlider(slider => {
                        slider.setLimits(1.5, 4, 0.25)
                            .setValue(this.plugin.settings.longPressSpeed)
                            .setDynamicTooltip()
                            .onChange(async (value) => {
                                this.plugin.settings.longPressSpeed = value;
                                await this.plugin.saveSettings();
                            });
                    });
            })
            .addSetting(setting => {
                setting
                    .setName('Long press delay')
                    .setDesc('How long to hold (in milliseconds) before fast forward kicks in.')
                    .addSlider(slider => {
                        slider.setLimits(200, 1000, 50)
                            .setValue(this.plugin.settings.longPressDelay)
                            .setDynamicTooltip()
                            .onChange(async (value) => {
                                this.plugin.settings.longPressDelay = value;
                                await this.plugin.saveSettings();
                            });
                    });
            });

        new SettingGroup(containerEl)
            .setHeading('Mobile fullscreen controls')
            .addSetting(setting => {
                setting
                    .setName('Move controls up')
                    .setDesc('Moves the progress bar and buttons a bit up in full screen mode to avoid being in a critical zone where system gestures might interfere.')
                    .addToggle(toggle => {
                        toggle.setValue(this.plugin.settings.fullscreenControlsEnabled)
                            .onChange(async (value) => {
                                this.plugin.settings.fullscreenControlsEnabled = value;
                                await this.plugin.saveSettings();
                            });
                    });
            })
            .addSetting(setting => {
                setting
                    .setName('Block input in fullscreen')
                    .setDesc('Stops touch and mouse gestures on a fullscreen video from reaching the canvas or other elements behind it. If this is off the drag gestures will e.g. pan your canvas in the background, which you normaly don\`t want.')
                    .addToggle(toggle => {
                        toggle.setValue(this.plugin.settings.blockInputInFullscreen)
                            .onChange(async (value) => {
                                this.plugin.settings.blockInputInFullscreen = value;
                                await this.plugin.saveSettings();
                            });
                    });
            });

        new SettingGroup(containerEl)
            .setHeading('Canvas thumbnail fix (mobile, experimental)')
            .addSetting(setting => {
                setting
                    .setName('Fix missing video thumbnails (experimental)')
                    .setDesc('On some Android devices, videos that all become visible at once (for example a zoomed-out canvas) can fail to render their first-frame thumbnail. This limits how many videos load at the same time and retries the ones that fail. Only has an effect on mobile; desktop is never touched. This is experimental and may not fully resolve the issue on every device.')
                    .addToggle(toggle => {
                        toggle.setValue(this.plugin.settings.thumbnailFixEnabled)
                            .onChange(async (value) => {
                                this.plugin.settings.thumbnailFixEnabled = value;
                                await this.plugin.saveSettings();
                            });
                    });
            })
            .addSetting(setting => {
                setting
                    .setName('Max concurrent loads')
                    .setDesc('How many videos are allowed to try to load a thumbnail at the same time. Lower values reduce resource contention but load thumbnails more slowly overall.')
                    .addSlider(slider => {
                        slider.setLimits(1, 6, 1)
                            .setValue(this.plugin.settings.thumbnailFixMaxConcurrent)
                            .setDynamicTooltip()
                            .onChange(async (value) => {
                                this.plugin.settings.thumbnailFixMaxConcurrent = value;
                                await this.plugin.saveSettings();
                            });
                    });
            })
            .addSetting(setting => {
                setting
                    .setName('Max retries per video')
                    .setDesc('How many times to retry loading a thumbnail before giving up on a video.')
                    .addSlider(slider => {
                        slider.setLimits(0, 8, 1)
                            .setValue(this.plugin.settings.thumbnailFixMaxRetries)
                            .setDynamicTooltip()
                            .onChange(async (value) => {
                                this.plugin.settings.thumbnailFixMaxRetries = value;
                                await this.plugin.saveSettings();
                            });
                    });
            })
            .addSetting(setting => {
                setting
                    .setName('Retry cooldown (ms)')
                    .setDesc('How long to wait before retrying a video that failed to produce a thumbnail.')
                    .addSlider(slider => {
                        slider.setLimits(200, 3000, 100)
                            .setValue(this.plugin.settings.thumbnailFixRetryDelayMs)
                            .setDynamicTooltip()
                            .onChange(async (value) => {
                                this.plugin.settings.thumbnailFixRetryDelayMs = value;
                                await this.plugin.saveSettings();
                            });
                    });
            });
    }
}
