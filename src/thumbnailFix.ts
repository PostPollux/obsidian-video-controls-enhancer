import { Platform } from 'obsidian';
import type VideoControlsEnhancer from './main';

/**
 * EXPERIMENTAL: Works around a mobile (Android WebView) issue where a lot
 * of <video> elements becoming visible at once (e.g. a zoomed-out canvas
 * full of video cards) causes many of them to never decode their first
 * frame, leaving the thumbnail blank forever - and where a video that
 * failed once tends to keep failing even if you just reset its `src`.
 *
 * How it works:
 *  1. Hard gating - the moment a video is discovered (and every time its
 *     `src` is (re)assigned afterwards - some hosts, like Obsidian's
 *     canvas, set `src` asynchronously *after* the element is inserted),
 *     the src (and any `<source>` children) is stripped and `preload` is
 *     set to `none` before the browser gets a chance to start fetching or
 *     decoding it. A MutationObserver keeps watching so a later src
 *     assignment can't sneak past the gate.
 *  2. Concurrency - videos are only "released" (src restored) one batch
 *     at a time, according to the configured concurrency, so the browser
 *     only ever works on a handful of videos at once instead of all of
 *     them fighting for decoder resources.
 *  3. Forced first-frame decode - once released, we wait for metadata and
 *     then nudge `currentTime` slightly, since some Android WebViews only
 *     decode a frame on seek.
 *  4. Fresh-element, round-robin retries - on some Android WebView
 *     versions, a video element that failed to decode a frame once seems
 *     to stay "stuck" even after clearing its `src` and calling `.load()`
 *     again, so failed attempts get a brand new <video> element (swapped
 *     in via `plugin.replaceVideoElement()`, which keeps touch controls
 *     working since they live on the wrapper, not the video itself).
 *     Crucially, a failed video does *not* hog its concurrency slot for
 *     all of its retries in a row: the slot is released immediately after
 *     each failed attempt, and the video only rejoins the *back* of the
 *     queue once its cooldown is over. This way a single problematic
 *     video can't starve every other video of even a first attempt.
 *  5. Fail fast - we also listen for the native `error` event instead of
 *     always waiting out the full timeout, so a definite failure (e.g. no
 *     decoder available right now) is detected (and can be retried)
 *     sooner instead of always waiting out the full timeout.
 */

const ATTRIBUTE = 'data-vce-thumb';
const PENDING_CLASS = 'vce-thumb-pending';
const THUMBNAIL_SEEK_TIME = 0.01;
const METADATA_TIMEOUT_MS = 5000;
const FRAME_TIMEOUT_MS = 6000;

interface CapturedSource {
    el: HTMLSourceElement;
    src: string;
}

interface QueueItem {
    video: HTMLVideoElement;
    attempts: number;
    originalSrcAttr: string | null;
    sources: CapturedSource[];
    /** true while the video's src/sources are currently stripped. */
    held: boolean;
}

interface VideoState {
    observer: MutationObserver;
    /** Currently queued, cooling down, or actively being processed, if any. */
    item: QueueItem | null;
    /** Set while we are the ones mutating src, so we can ignore our own mutation records. */
    suppress: boolean;
}

export class ThumbnailFixManager {
    private plugin: VideoControlsEnhancer;
    private queue: QueueItem[] = [];
    private activeItems = new Set<QueueItem>();
    /** Items that failed an attempt and are waiting out their cooldown before rejoining the queue. */
    private coolingDownItems = new Set<QueueItem>();
    private active = 0;
    private destroyed = false;
    private states = new WeakMap<HTMLVideoElement, VideoState>();

    constructor(plugin: VideoControlsEnhancer) {
        this.plugin = plugin;
    }

    destroy(): void {
        this.destroyed = true;
        for (const item of this.queue) this.stopManaging(item);
        for (const item of this.activeItems) this.stopManaging(item);
        for (const item of this.coolingDownItems) this.stopManaging(item);
        this.queue = [];
        this.activeItems.clear();
        this.coolingDownItems.clear();
    }

    /**
     * Registers a video for the thumbnail fix. Safe to call multiple
     * times for the same element (it's only set up once). Also keeps
     * watching the element afterwards in case its src is assigned later
     * (asynchronously) rather than being present right away.
     */
    handleVideo(video: HTMLVideoElement): void {
        // Desktop doesn't have the decoder-contention problem this works
        // around; leave it completely untouched there.
        if (!Platform.isMobile) return;
        if (!this.plugin.settings.thumbnailFixEnabled) return;
        if (video.hasAttribute(ATTRIBUTE)) return;
        video.setAttribute(ATTRIBUTE, 'true');

        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;

        // Show the "pending" placeholder right away, before src is even
        // known to exist, so there's no visible jump later from "plain
        // empty box" to "grey pending box" once src shows up and gets
        // gated - it looks the same the whole time until it succeeds.
        this.setPendingVisual(video, true);
        this.trackVideo(video);
        this.tryClaim(video);
    }

    private trackVideo(video: HTMLVideoElement): void {
        if (this.states.has(video)) return;
        const observer = new MutationObserver(() => this.onPossibleSrcChange(video));
        observer.observe(video, { attributes: true, attributeFilter: ['src'], childList: true, subtree: true });
        this.states.set(video, { observer, item: null, suppress: false });
    }

    private hasAnySrc(video: HTMLVideoElement): boolean {
        if (video.getAttribute('src')) return true;
        const sources = video.querySelectorAll('source');
        for (let i = 0; i < sources.length; i++) {
            if (sources[i]?.getAttribute('src')) return true;
        }
        return false;
    }

    /** Picks up a video that now has a real src to manage, if it isn't already being managed. */
    private tryClaim(video: HTMLVideoElement): void {
        const state = this.states.get(video);
        if (!state || state.item) return;
        if (!video.isConnected) return;
        if (!this.hasAnySrc(video)) return;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;

        const item = this.capture(video);
        state.item = item;
        this.strip(item);
        this.queue.push(item);
        this.pump();
    }

    private onPossibleSrcChange(video: HTMLVideoElement): void {
        const state = this.states.get(video);
        if (!state || state.suppress) return;

        if (state.item) {
            // We're already managing this video. If we're currently
            // holding it (src stripped) and something external just put a
            // src back, immediately re-capture and re-strip so the
            // outside actor's assignment doesn't bypass our gating.
            if (state.item.held) {
                this.recapture(state.item);
                this.strip(state.item);
            }
            return;
        }

        // Not tracked yet (e.g. this element never had a src when
        // handleVideo() first ran) - claim it now that one exists.
        this.tryClaim(video);
    }

    private capture(video: HTMLVideoElement): QueueItem {
        const sourceEls = Array.from(video.querySelectorAll('source'));
        const sources: CapturedSource[] = sourceEls.map((el) => ({ el, src: el.getAttribute('src') ?? '' }));
        return {
            video,
            attempts: 0,
            originalSrcAttr: video.getAttribute('src'),
            sources,
            held: false,
        };
    }

    private recapture(item: QueueItem): void {
        item.originalSrcAttr = item.video.getAttribute('src');
        const sourceEls = Array.from(item.video.querySelectorAll('source'));
        item.sources = sourceEls.map((el) => ({ el, src: el.getAttribute('src') ?? '' }));
    }

    private setPendingVisual(video: HTMLVideoElement, pending: boolean): void {
        const wrapper = video.parentElement;
        wrapper?.classList.toggle(PENDING_CLASS, pending);
    }

    private withSuppressedMutations(video: HTMLVideoElement, fn: () => void): void {
        const state = this.states.get(video);
        if (state) state.suppress = true;
        try {
            fn();
        } finally {
            if (state) {
                // The MutationObserver microtask for the mutation we just
                // caused is queued before this one, so it will see
                // suppress === true; this clears it right after.
                queueMicrotask(() => { state.suppress = false; });
            }
        }
    }

    /** Strips src/sources so the browser stops trying to load the video. */
    private strip(item: QueueItem): void {
        if (item.held) return;
        const { video } = item;
        this.withSuppressedMutations(video, () => {
            video.preload = 'none';
            video.removeAttribute('src');
            for (const s of item.sources) {
                if (s.src) s.el.removeAttribute('src');
            }
            try { video.load(); } catch { /* ignore */ }
        });
        item.held = true;
        this.setPendingVisual(video, true);
    }

    /** Restores src/sources so the video can actually start loading. */
    private restore(item: QueueItem): void {
        if (!item.held) return;
        const { video } = item;
        this.withSuppressedMutations(video, () => {
            video.preload = 'auto';
            if (item.originalSrcAttr !== null) video.setAttribute('src', item.originalSrcAttr);
            for (const s of item.sources) {
                if (s.src) s.el.setAttribute('src', s.src);
            }
            try { video.load(); } catch { /* ignore */ }
        });
        item.held = false;
        this.setPendingVisual(video, false);
    }

    private cleanup(video: HTMLVideoElement): void {
        const state = this.states.get(video);
        if (state) {
            state.observer.disconnect();
            this.states.delete(video);
        }
    }

    /**
     * Final exit point whenever we stop trying to fix a video's
     * thumbnail (success, permanent failure, disconnect, or the feature
     * being turned off mid-flight). Always makes sure the video is left
     * in a normal, visible, playable state and that we stop watching it
     * afterwards, so it never gets stuck permanently hidden/grey and
     * nothing keeps re-claiming it later.
     */
    private stopManaging(item: QueueItem): void {
        if (item.held) this.restore(item);
        this.setPendingVisual(item.video, false);
        this.cleanup(item.video);
    }

    private pump(): void {
        if (this.destroyed) return;
        if (!this.plugin.settings.thumbnailFixEnabled) {
            for (const item of this.queue) this.stopManaging(item);
            this.queue = [];
            return;
        }
        const max = Math.max(1, this.plugin.settings.thumbnailFixMaxConcurrent);
        while (this.active < max && this.queue.length > 0) {
            const item = this.queue.shift();
            if (!item) break;
            this.active++;
            this.activeItems.add(item);
            this.process(item)
                .catch(() => { /* ignore - best effort */ })
                .finally(() => {
                    this.active--;
                    this.activeItems.delete(item);
                    this.pump();
                });
        }
    }

    private waitForEvent(target: EventTarget, events: string[], timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            let done = false;
            const onEvent = () => {
                if (done) return;
                done = true;
                cleanup();
                resolve(true);
            };
            const cleanup = () => {
                for (const ev of events) target.removeEventListener(ev, onEvent);
                window.clearTimeout(timer);
            };
            const timer = window.setTimeout(() => {
                if (done) return;
                done = true;
                cleanup();
                resolve(false);
            }, timeoutMs);
            for (const ev of events) target.addEventListener(ev, onEvent, { once: true });
        });
    }

    /**
     * Runs exactly one load attempt for the item's current video: waits
     * for metadata, then nudges currentTime to force a frame decode.
     * Resolves to whether it succeeded. Also listens for the `error`
     * event so a definite failure (e.g. no decoder available right now)
     * is detected as soon as the browser reports it instead of always
     * waiting out the full timeout.
     */
    private async attemptOnce(video: HTMLVideoElement): Promise<boolean> {
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
            await this.waitForEvent(video, ['loadedmetadata', 'error'], METADATA_TIMEOUT_MS);
            if (video.error) return false;
            if (video.readyState < HTMLMediaElement.HAVE_METADATA) return false;
        }

        if (!video.isConnected) return false;
        if (video.error) return false;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return true;

        const framePromise = this.waitForEvent(video, ['seeked', 'loadeddata', 'error'], FRAME_TIMEOUT_MS);
        try {
            const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
            video.currentTime = Math.min(THUMBNAIL_SEEK_TIME, Math.max(0, duration - 0.001));
        } catch {
            // Some browsers throw if the media isn't seekable yet; the
            // timeout below will trigger a retry in that case.
        }
        await framePromise;
        if (video.error) return false;
        return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    }

    /**
     * Handles exactly one item's turn in an active concurrency slot: one
     * load attempt, then either finish (success/give up) or hand off to
     * `scheduleRetry()` - which does *not* keep occupying a slot - so a
     * single problematic video can't block everything else behind it.
     */
    private async process(item: QueueItem): Promise<void> {
        const video = item.video;

        if (!video.isConnected) {
            this.cleanup(video);
            return;
        }

        // This is this item's turn - let it actually load now.
        if (item.held) this.restore(item);

        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            this.stopManaging(item);
            return;
        }

        item.attempts++;
        const ok = await this.attemptOnce(video);

        if (ok) {
            this.stopManaging(item);
            return;
        }

        if (!video.isConnected) {
            this.cleanup(video);
            return;
        }

        const maxRetries = Math.max(0, this.plugin.settings.thumbnailFixMaxRetries);
        if (item.attempts > maxRetries || this.destroyed || !this.plugin.settings.thumbnailFixEnabled) {
            this.stopManaging(item);
            return;
        }

        this.scheduleRetry(item);
    }

    /**
     * Called after a failed attempt that still has retries left. Detaches
     * the old element's resource, waits out the cooldown *without* holding
     * a concurrency slot, then swaps in a fresh <video> element and puts
     * it at the *back* of the queue so other, not-yet-tried videos get a
     * turn first.
     */
    private scheduleRetry(item: QueueItem): void {
        this.strip(item);
        this.coolingDownItems.add(item);

        window.setTimeout(() => {
            this.coolingDownItems.delete(item);

            if (this.destroyed || !this.plugin.settings.thumbnailFixEnabled) {
                this.stopManaging(item);
                return;
            }
            if (!item.video.isConnected) {
                this.cleanup(item.video);
                return;
            }

            const newItem = this.swapInFreshElement(item);
            if (!newItem) {
                this.stopManaging(item);
                return;
            }

            this.queue.push(newItem);
            this.pump();
        }, this.plugin.settings.thumbnailFixRetryDelayMs);
    }

    /**
     * Creates a brand new <video> element carrying over the relevant
     * state, and swaps it into the DOM. The clone is created *without*
     * its src re-assigned (kept only in the returned item's
     * `originalSrcAttr`/`sources`, marked as `held`) so it re-enters the
     * queue exactly like any freshly discovered video, waiting its turn
     * instead of jumping ahead and loading immediately.
     */
    private swapInFreshElement(item: QueueItem): QueueItem | null {
        const oldVideo = item.video;
        if (!oldVideo.isConnected) return null;

        const newVideo = oldVideo.cloneNode(false) as HTMLVideoElement;
        newVideo.setAttribute(ATTRIBUTE, 'true');
        newVideo.preload = 'none';
        newVideo.removeAttribute('src');

        const newSources: CapturedSource[] = [];
        for (const s of item.sources) {
            const clonedSource = s.el.cloneNode(true) as HTMLSourceElement;
            clonedSource.removeAttribute('src');
            newVideo.appendChild(clonedSource);
            newSources.push({ el: clonedSource, src: s.src });
        }

        const replaced = this.plugin.replaceVideoElement(oldVideo, newVideo);
        if (!replaced) return null;

        this.cleanup(oldVideo);
        this.trackVideo(newVideo);
        const state = this.states.get(newVideo);

        const newItem: QueueItem = {
            video: newVideo,
            attempts: item.attempts,
            originalSrcAttr: item.originalSrcAttr,
            sources: newSources,
            held: true,
        };
        if (state) state.item = newItem;

        return newItem;
    }
}
