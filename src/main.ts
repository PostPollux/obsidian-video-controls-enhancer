import { Plugin } from 'obsidian';

interface PluginSettings {
    doubleTapEnabled: boolean;
    doubleTapSeconds: number;
    scrubEnabled: boolean;
    scrubSensitivity: number;
    volumeEnabled: boolean;
    fullscreenControlsEnabled: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
    doubleTapEnabled: true,
    doubleTapSeconds: 10,
    scrubEnabled: true,
    scrubSensitivity: 30,
    volumeEnabled: true,
    fullscreenControlsEnabled: true,
};

export default class VideoControlsEnhancer extends Plugin {
    settings!: PluginSettings;
    private observer: MutationObserver | null = null;

    async onload() {
        await this.loadSettings();
        this.applyFsControlsClass();

        this.registerMarkdownPostProcessor((element) => {
            const videos = element.querySelectorAll<HTMLVideoElement>('video:not([data-vce])');
            for (let i = 0; i < videos.length; i++) {
                const video = videos[i];
                if (video) this.enhanceVideo(video);
            }
        });

        this.observer = new MutationObserver((mutations) => {
            for (let mi = 0; mi < mutations.length; mi++) {
                const m = mutations[mi];
                if (!m) continue;
                for (let ni = 0; ni < m.addedNodes.length; ni++) {
                    const node = m.addedNodes[ni];
                    if (node instanceof HTMLElement) {
                        if (node.tagName === 'VIDEO' && !node.hasAttribute('data-vce')) {
                            this.enhanceVideo(node as HTMLVideoElement);
                        }
                        const videos = node.querySelectorAll<HTMLVideoElement>('video:not([data-vce])');
                        for (let i = 0; i < videos.length; i++) {
                            const video = videos[i];
                            if (video) this.enhanceVideo(video);
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

    enhanceVideo(video: HTMLVideoElement) {
        if (video.hasAttribute('data-vce')) return;
        video.setAttribute('data-vce', 'true');

        const wrapper = document.createElement('div');
        wrapper.className = 'video-controls-enhancer-wrapper';
        video.parentNode?.insertBefore(wrapper, video);
        wrapper.appendChild(video);

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

        const formatTime = (s: number): string => {
            if (!isFinite(s) || s <= 0) return '0:00';
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return `${m}:${sec.toString().padStart(2, '0')}`;
        };

        const showOverlay = (x: number, y: number, text: string) => {
            if (overlayTimer) { window.clearTimeout(overlayTimer); overlayTimer = null; }
            if (!overlayEl) {
                overlayEl = document.createElement('div');
                overlayEl.className = 'vce-overlay';
                document.body.appendChild(overlayEl);
            }
            overlayEl.classList.remove('vce-overlay-fade');
            overlayEl.textContent = text;
            overlayEl.style.left = `${x}px`;
            overlayEl.style.top = `${y - 50}px`;
            overlayTimer = window.setTimeout(() => {
                overlayEl?.classList.add('vce-overlay-fade');
                overlayTimer = window.setTimeout(() => {
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
            const deltaX = clientX - dragStartX;
            const deltaY = clientY - dragStartY;

            if (dragMode === 'none') {
                if (Math.abs(deltaX) < 5 && Math.abs(deltaY) < 5) return;
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
                showOverlay(clientX, clientY, `\uD83D\uDD0A ${pct}%`);
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
        });

        wrapper.addEventListener('mousemove', (e: MouseEvent) => {
            if (e.buttons !== 1) return;
            updateDrag(e.clientX, e.clientY);
        });

        wrapper.addEventListener('mouseup', endDrag);
        wrapper.addEventListener('mouseleave', () => {
            if (isDragging) fadeOverlay();
            dragMode = 'none';
            isDragging = false;
        });

        wrapper.addEventListener('click', (e: MouseEvent) => {
            if (isInControls(e.clientY)) return;
            if (justDragged) {
                justDragged = false;
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
        }, { passive: false });

        wrapper.addEventListener('touchmove', (e: TouchEvent) => {
            const t = e.touches[0];
            if (!t) return;
            updateDrag(t.clientX, t.clientY);
        }, { passive: true });

        wrapper.addEventListener('touchend', endDrag);
    }
}

import { App, PluginSettingTab, Setting } from 'obsidian';

class VideoControlsSettingTab extends PluginSettingTab {
    plugin: VideoControlsEnhancer;

    constructor(app: App, plugin: VideoControlsEnhancer) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl).setName('Double tap').setHeading();

        new Setting(containerEl)
            .setName('Enable double tap')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.doubleTapEnabled)
                    .onChange(async (value) => {
                        this.plugin.settings.doubleTapEnabled = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
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

        new Setting(containerEl).setName('Scrub (horizontal drag)').setHeading();

        new Setting(containerEl)
            .setName('Enable scrubbing')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.scrubEnabled)
                    .onChange(async (value) => {
                        this.plugin.settings.scrubEnabled = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
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

        new Setting(containerEl).setName('Volume (vertical drag)').setHeading();

        new Setting(containerEl)
            .setName('Enable volume control')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.volumeEnabled)
                    .onChange(async (value) => {
                        this.plugin.settings.volumeEnabled = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl).setName('Mobile fullscreen controls').setHeading();

        new Setting(containerEl)
            .setName('Move controls up')
            .setDesc('Moves the progress bar and buttons a bit up in full screen mode to avoid being in a critical zone where system gestures might interfere.')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.fullscreenControlsEnabled)
                    .onChange(async (value) => {
                        this.plugin.settings.fullscreenControlsEnabled = value;
                        await this.plugin.saveSettings();
                    });
            });
    }
}
