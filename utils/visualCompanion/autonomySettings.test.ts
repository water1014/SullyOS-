import { afterEach, describe, expect, it } from 'vitest';
import {
    createDefaultVisualAutonomySettings,
    loadVisualAutonomySettings,
    resetVisualAutonomySettings,
    saveVisualAutonomySettings,
} from './autonomySettings';

afterEach(() => localStorage.clear());

describe('per-character visual autonomy settings', () => {
    it('defaults to no unsolicited generation until the user enables it', () => {
        const settings = createDefaultVisualAutonomySettings(123);
        expect(settings.enabled).toBe(false);
        expect(settings.allowSpontaneousShare).toBe(false);
        expect(settings.requireApprovalForNewIdentity).toBe(true);
        expect(settings.frequency).toBe('natural');
        expect(settings.updatedAt).toBe(123);
    });

    it('persists settings separately for each character', () => {
        const saved = saveVisualAutonomySettings('char_a', {
            ...createDefaultVisualAutonomySettings(),
            enabled: true,
            allowSpontaneousShare: true,
            dailyImageLimit: 2,
            quietHours: { start: '23:00', end: '08:00' },
        });
        expect(loadVisualAutonomySettings('char_a')).toEqual(saved);
        expect(loadVisualAutonomySettings('char_b').enabled).toBe(false);
    });

    it('normalizes malformed stored values and clamps the daily image limit', () => {
        localStorage.setItem('sully-visual-autonomy:v1:char_a', JSON.stringify({
            enabled: 'yes',
            frequency: 'turbo',
            dailyImageLimit: 9999,
            allowSpontaneousShare: 1,
            requireApprovalForNewIdentity: false,
        }));
        const settings = loadVisualAutonomySettings('char_a');
        expect(settings.enabled).toBe(false);
        expect(settings.frequency).toBe('natural');
        expect(settings.dailyImageLimit).toBe(100);
        expect(settings.allowSpontaneousShare).toBe(false);
        expect(settings.requireApprovalForNewIdentity).toBe(false);
    });

    it('resets only the selected character', () => {
        saveVisualAutonomySettings('char_a', { ...createDefaultVisualAutonomySettings(), enabled: true });
        saveVisualAutonomySettings('char_b', { ...createDefaultVisualAutonomySettings(), enabled: true });
        resetVisualAutonomySettings('char_a');
        expect(loadVisualAutonomySettings('char_a').enabled).toBe(false);
        expect(loadVisualAutonomySettings('char_b').enabled).toBe(true);
    });
});
