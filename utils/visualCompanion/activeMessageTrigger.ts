/**
 * Active-message → visual autonomy trigger.
 *
 * Only queues a local task after a scheduled proactive message has been fully received.
 * It never calls a Provider and never copies credentials into task metadata.
 */
import type { ActiveMsg2InboxMessage } from '../../types';
import { loadVisualAutonomySettings } from './autonomySettings';
import { createAutonomousVisualTask } from './orchestrator';
import { executeVisualTaskInForeground } from './foregroundExecutor';
import { visualCompanionRepository } from './repository';
import type { VisualAutonomySettings, VisualProviderKind } from './types';
import type { VisualShareContextKind } from './autonomyPolicy';

const IMAGE_CONFIG_KEY = 'sully-image-studio:config:v1';
const CONTEXT_KINDS = new Set<VisualShareContextKind>([
    'ordinary_conversation',
    'emotional_high',
    'milestone',
    'reunion',
]);

type ProviderSelection = {
    provider: VisualProviderKind;
    providerConfigId: string;
    model: string;
};

function readProviderSelection(preference: VisualAutonomySettings['providerPreference']): ProviderSelection | null {
    try {
        const saved = JSON.parse(localStorage.getItem(IMAGE_CONFIG_KEY) || '{}');
        const gpt = saved?.gpt || {};
        const legacyNai = saved?.nai || {};
        const official = saved?.naiOfficial || (legacyNai.provider !== 'thirdparty' ? legacyNai : {});
        const thirdParty = saved?.naiThirdParty || (legacyNai.provider === 'thirdparty' ? legacyNai : {});

        const selections: Record<Exclude<VisualAutonomySettings['providerPreference'], 'auto'>, ProviderSelection | null> = {
            gpt: typeof gpt.apiKey === 'string' && gpt.apiKey.trim() && typeof gpt.baseUrl === 'string' && gpt.baseUrl.trim() ? {
                provider: 'openai_compatible',
                providerConfigId: 'image-studio:gpt',
                model: typeof gpt.model === 'string' && gpt.model.trim() ? gpt.model : 'gpt-image-2.5-flare',
            } : null,
            nai_official: typeof official.apiKey === 'string' && official.apiKey.trim() ? {
                provider: 'novelai_official',
                providerConfigId: 'image-studio:nai-official',
                model: typeof official.model === 'string' && official.model.trim() ? official.model : 'nai-diffusion-5-full',
            } : null,
            nai_thirdparty: typeof thirdParty.apiKey === 'string' && thirdParty.apiKey.trim() && typeof thirdParty.baseUrl === 'string' && thirdParty.baseUrl.trim() ? {
                provider: 'novelai_compatible',
                providerConfigId: 'image-studio:nai-third-party',
                model: typeof thirdParty.model === 'string' && thirdParty.model.trim() ? thirdParty.model : 'nai-diffusion-5-full',
            } : null,
        };
        if (preference !== 'auto') return selections[preference];
        return selections.gpt || selections.nai_official || selections.nai_thirdparty;
    } catch {
        return null;
    }
}

function resolveContextKind(message: ActiveMsg2InboxMessage): VisualShareContextKind {
    const candidate = message.metadata?.visualShareContextKind;
    return typeof candidate === 'string' && CONTEXT_KINDS.has(candidate as VisualShareContextKind)
        ? candidate as VisualShareContextKind
        : 'ordinary_conversation';
}

function isFinalMessageChunk(message: ActiveMsg2InboxMessage): boolean {
    const metadata = message.metadata || {};
    const index = Number((message as any).messageIndex ?? metadata.messageIndex ?? 0);
    const total = Number((message as any).totalMessages ?? metadata.totalMessages ?? 0);
    // Older workers omit chunk metadata. In that case each push is treated as a single message.
    return !(Number.isInteger(index) && Number.isInteger(total) && total > 0 && index > 0 && index < total);
}

/**
 * Called after a scheduled proactive assistant message has landed in the local chat history.
 * Returns a short outcome for logs; failures are intentionally isolated from chat delivery.
 */
export async function maybeQueueVisualShareForActiveMessage(
    message: ActiveMsg2InboxMessage,
): Promise<'not_applicable' | 'not_ready' | 'denied' | 'queued'> {
    if (message.source !== 'scheduled' || !isFinalMessageChunk(message)) return 'not_applicable';

    const settings = loadVisualAutonomySettings(message.charId);
    if (!settings.enabled || !settings.allowSpontaneousShare || settings.frequency === 'paused') return 'denied';

    const profile = (await visualCompanionRepository.listProfiles(message.charId))
        .filter(item => item.status === 'active')
        .sort((a, b) => b.version - a.version)[0];
    if (!profile || !profile.anchorPrompt.trim()) return 'not_ready';

    const provider = readProviderSelection(settings.providerPreference);
    if (!provider) return 'not_ready';

    // NovelAI's official API documentation requires image generations to be initiated
    // by a human action. Keep NAI available for explicit user-triggered creation, but
    // never call it from this autonomous scheduled-message path. Third-party proxies
    // are gated too until their own automation terms are explicitly verified.
    if (provider.provider === 'novelai_official' || provider.provider === 'novelai_compatible') {
        return 'not_ready';
    }

    const now = Date.now();
    const localDate = new Date(now);
    const dayStart = new Date(localDate.getFullYear(), localDate.getMonth(), localDate.getDate()).getTime();
    const [assets, tasks] = await Promise.all([
        visualCompanionRepository.listAssets(message.charId),
        visualCompanionRepository.listTasks(message.charId),
    ]);
    const imagesGeneratedToday = assets.filter(asset =>
        asset.privacyScope === 'standard'
        && asset.status === 'ready'
        && asset.createdAt >= dayStart
    ).length;
    const lastShareAt = tasks
        .filter(task => task.kind === 'spontaneous_share' && task.status === 'delivered')
        .reduce<number | undefined>((latest, task) =>
            latest === undefined || task.updatedAt > latest ? task.updatedAt : latest, undefined);

    const contextKind = resolveContextKind(message);
    const prompt = [
        profile.anchorPrompt.trim(),
        'Create one natural, intimate everyday photo of this same character, as if he spontaneously shared a moment from his day.',
        'Keep the established identity and art style consistent. No captions, no text, no watermark.',
        contextKind === 'ordinary_conversation'
            ? 'Choose a calm, believable daily-life moment. Avoid inventing specific events or locations.'
            : 'Reflect the supplied conversation moment gently without adding unsupported factual details.',
    ].join('\n');

    const deliveryId = `active-msg-visual:${encodeURIComponent(message.charId)}:${encodeURIComponent(message.messageId)}`;
    const result = await createAutonomousVisualTask(settings, {
        kind: contextKind,
        now,
        localTime: `${String(localDate.getHours()).padStart(2, '0')}:${String(localDate.getMinutes()).padStart(2, '0')}`,
        lastShareAt,
        imagesGeneratedToday,
        sample: Math.random(),
    }, {
        charId: message.charId,
        kind: 'spontaneous_share',
        privacyScope: 'standard',
        provider: provider.provider,
        providerConfigId: provider.providerConfigId,
        model: provider.model,
        prompt,
        referenceAssetIds: profile.baseAssetId ? [profile.baseAssetId] : [],
        sourceEventId: message.messageId,
        deliveryId,
        maxAttempts: 2,
        budget: { maxImages: 1 },
    });

    if (!result.task) return 'denied';

    // Run while the browser page is alive. If the page closes, the queued task remains local;
    // durable background execution is a later phase and is not claimed here.
    void executeVisualTaskInForeground(result.task.id).catch(error => {
        console.warn('[VisualCompanion] foreground executor could not start', {
            taskId: result.task?.id,
            error,
        });
    });
    return 'queued';
}
