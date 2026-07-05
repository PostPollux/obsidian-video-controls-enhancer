import { Plugin } from 'obsidian';

interface PluginSettings {
    doubleTapSeconds: number;
}

const DEFAULT_SETTINGS: PluginSettings = {
    doubleTapSeconds: 10
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

        const showOverlay = (clientX: number, clientY: number, text: string) => {
            const old = document.querySelector('.vce-overlay');
            if (old) old.remove();

            const overlay = document.createElement('div');
            overlay.className = 'vce-overlay';
            overlay.textContent = text;
            overlay.style.left = `${clientX}px`;
            overlay.style.top = `${clientY}px`;

            document.body.appendChild(overlay);

            window.setTimeout(() => {
                overlay.classList.add('vce-overlay-fade');
                window.setTimeout(() => overlay.remove(), 400);
            }, 400);
        };

        const handleDouble = (clientX: number, clientY: number) => {
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

        video.addEventListener('click', (e: MouseEvent) => {
            if (handleDouble(e.clientX, e.clientY)) {
                e.preventDefault();
                e.stopPropagation();
            }
        });

        video.addEventListener('touchstart', (e: TouchEvent) => {
            const t = e.touches[0];
            if (!t) return;
            if (handleDouble(t.clientX, t.clientY)) {
                e.preventDefault();
            }
        }, { passive: false });
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
    }
}
