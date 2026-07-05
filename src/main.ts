import { Plugin } from 'obsidian';

interface PluginSettings {
    doubleTapSeconds: number;
    scrubSensitivity: number;
}

const DEFAULT_SETTINGS: PluginSettings = {
    doubleTapSeconds: 10,
    scrubSensitivity: 30
};

export default class VideoControlsEnhancer extends Plugin {
    settings!: PluginSettings;
    private observer: MutationObserver | null = null;

    async onload() {
        await this.loadSettings();

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
    }

    enhanceVideo(video: HTMLVideoElement) {
        if (video.hasAttribute('data-vce')) return;
        video.setAttribute('data-vce', 'true');

        const wrapper = document.createElement('div');
        wrapper.className = 'video-controls-enhancer-wrapper';
        video.parentNode?.insertBefore(wrapper, video);
        wrapper.appendChild(video);

        let lastTapTime = 0;
        let scrubStartX = 0;
        let scrubStartTime = 0;
        let isScrubbing = false;
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
            overlayEl.style.top = `${y}px`;
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

        const doDoubleTap = (clientX: number, clientY: number) => {
            const now = Date.now();
            if (now - lastTapTime < 400) {
                const rect = wrapper.getBoundingClientRect();
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

        const beginScrub = (clientX: number) => {
            scrubStartX = clientX;
            scrubStartTime = video.currentTime;
            isScrubbing = false;
        };

        const updateScrub = (clientX: number, clientY: number) => {
            const deltaX = clientX - scrubStartX;
            if (Math.abs(deltaX) < 5) return;
            isScrubbing = true;
            const rect = wrapper.getBoundingClientRect();
            const sensitivity = this.settings.scrubSensitivity / 100;
            const timeChange = (deltaX / rect.width) * video.duration * sensitivity;
            const newTime = Math.max(0, Math.min(video.duration, scrubStartTime + timeChange));
            video.currentTime = newTime;
            showOverlay(clientX, clientY, formatTime(newTime));
        };

        const endScrub = () => {
            if (isScrubbing) {
                lastTapTime = 0;
                fadeOverlay();
            }
            isScrubbing = false;
        };

        wrapper.addEventListener('mousedown', (e: MouseEvent) => {
            beginScrub(e.clientX);
        });

        wrapper.addEventListener('mousemove', (e: MouseEvent) => {
            if (e.buttons !== 1) return;
            updateScrub(e.clientX, e.clientY);
        });

        wrapper.addEventListener('mouseup', endScrub);
        wrapper.addEventListener('mouseleave', () => {
            if (isScrubbing) fadeOverlay();
            isScrubbing = false;
        });

        wrapper.addEventListener('click', (e: MouseEvent) => {
            if (doDoubleTap(e.clientX, e.clientY)) {
                e.preventDefault();
                e.stopPropagation();
            }
        });

        wrapper.addEventListener('touchstart', (e: TouchEvent) => {
            const t = e.touches[0];
            if (!t) return;
            if (doDoubleTap(t.clientX, t.clientY)) {
                e.preventDefault();
                return;
            }
            beginScrub(t.clientX);
        }, { passive: false });

        wrapper.addEventListener('touchmove', (e: TouchEvent) => {
            const t = e.touches[0];
            if (!t) return;
            updateScrub(t.clientX, t.clientY);
        }, { passive: true });

        wrapper.addEventListener('touchend', endScrub);
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

        new Setting(containerEl)
            .setName('Double tap jump')
            .setDesc('Amount of seconds to jump back or forth on double tap.')
            .addSlider(slider => {
                slider.setLimits(1, 30, 1)
                    .setValue(this.plugin.settings.doubleTapSeconds)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.doubleTapSeconds = value;
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
    }
}
