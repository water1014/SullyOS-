import React, { useMemo, useRef, useState } from 'react';
import { useOS } from '../context/OSContext';
import { ArrowLeft, ArrowUp, ArrowDown, CheckCircle, DownloadSimple, PencilSimple, Plus, Trash, UploadSimple, X } from '@phosphor-icons/react';
import { parseTavernPromptPreset, type TavernPromptPreset } from '../utils/tavernPromptPreset';
import { readShareFile } from '../utils/pngShare';
import { shareOrDownloadFile } from '../utils/shareExport';

const PRESETS_KEY = 'sully-tavern-prompt-presets:v1';
const ACTIVE_KEY = 'sully-tavern-prompt-preset-active:v1';

const readPresets = (): TavernPromptPreset[] => {
    try {
        const value = JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]');
        return Array.isArray(value) ? value.filter(item =>
            item && typeof item.name === 'string' && Array.isArray(item.prompts)
        ) as TavernPromptPreset[] : [];
    } catch {
        return [];
    }
};

const PromptPresetsApp: React.FC = () => {
    const { closeApp, addToast } = useOS();
    const [presets, setPresets] = useState<TavernPromptPreset[]>(readPresets);
    const [activeName, setActiveName] = useState(() => {
        try { return localStorage.getItem(ACTIVE_KEY) || ''; } catch { return ''; }
    });
    const [expandedName, setExpandedName] = useState<string | null>(null);
    const [editingName, setEditingName] = useState<string | null>(null);
    const importRef = useRef<HTMLInputElement>(null);

    const activePreset = useMemo(
        () => presets.find(item => item.name === activeName) || null,
        [presets, activeName],
    );

    const persist = (next: TavernPromptPreset[], nextActive = activeName) => {
        setPresets(next);
        setActiveName(nextActive);
        try {
            localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
            if (nextActive) localStorage.setItem(ACTIVE_KEY, nextActive);
            else localStorage.removeItem(ACTIVE_KEY);
        } catch {
            addToast('本机存储空间不足，预设修改未能保存', 'error');
        }
    };

    const updatePreset = (name: string, updater: (preset: TavernPromptPreset) => TavernPromptPreset) => {
        const current = presets.find(item => item.name === name);
        if (!current) return;
        const updated = updater(current);
        const next = presets.map(item => item.name === name ? updated : item);
        const nextActive = activeName === name ? updated.name : activeName;
        persist(next, nextActive);
        if (expandedName === name) setExpandedName(updated.name);
        if (editingName === name) setEditingName(updated.name);
    };

    const importPreset = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const source = await readShareFile(file, 'worldbook');
            const parsed = parseTavernPromptPreset(await source.text(), source.name);
            const next = [parsed, ...presets.filter(item => item.name !== parsed.name)];
            const nextActive = presets.some(item => item.name === activeName) ? activeName : parsed.name;
            persist(next, nextActive);
            setExpandedName(parsed.name);
            setEditingName(null);
            addToast(`已导入「${parsed.name}」，包含 ${parsed.prompts.length} 个模块`, 'success');
        } catch (error: any) {
            addToast(error?.message || '提示词预设导入失败', 'error');
        } finally {
            event.target.value = '';
        }
    };

    const activate = (name: string) => {
        persist(presets, name);
        addToast(`已启用「${name}」，下次普通私聊请求时生效`, 'success');
    };

    const rename = (name: string, value: string) => {
        const nextName = value.trim();
        if (!nextName || nextName === name) return;
        if (presets.some(item => item.name === nextName)) {
            addToast('已经有同名预设，请换一个名称', 'error');
            return;
        }
        updatePreset(name, preset => ({ ...preset, name: nextName }));
    };

    const updateModule = (presetName: string, index: number, patch: Partial<TavernPromptPreset['prompts'][number]>) => {
        updatePreset(presetName, preset => ({
            ...preset,
            prompts: preset.prompts.map((prompt, i) => i === index ? { ...prompt, ...patch } : prompt),
            // 用户在界面手动改模块开关/内容后，以本机编辑状态为准，
            // 不再被导入 JSON 中旧的 prompt_order.enabled 覆盖。
            manualOrder: true,
        }));
    };

    const moveModule = (presetName: string, index: number, direction: -1 | 1) => {
        updatePreset(presetName, preset => {
            const prompts = [...preset.prompts];
            const target = index + direction;
            if (target < 0 || target >= prompts.length) return preset;
            [prompts[index], prompts[target]] = [prompts[target], prompts[index]];
            return { ...preset, prompts, manualOrder: true };
        });
    };

    const addModule = (presetName: string) => {
        updatePreset(presetName, preset => ({
            ...preset,
            prompts: [...preset.prompts, {
                identifier: `custom_module_${Date.now()}`,
                name: '新提示词模块',
                role: 'system',
                content: '',
                enabled: true,
            }],
            manualOrder: true,
        }));
        setEditingName(presetName);
    };

    const deleteModule = (presetName: string, index: number) => {
        updatePreset(presetName, preset => ({
            ...preset,
            prompts: preset.prompts.filter((_, i) => i !== index),
            manualOrder: true,
        }));
    };

    const deletePreset = (name: string) => {
        const next = presets.filter(item => item.name !== name);
        const nextActive = activeName === name ? (next[0]?.name || '') : activeName;
        persist(next, nextActive);
        if (expandedName === name) setExpandedName(null);
        if (editingName === name) setEditingName(null);
        addToast(`已删除「${name}」`, 'success');
    };

    const exportPreset = async (preset: TavernPromptPreset) => {
        const order = preset.prompt_order.map(group => ({
            ...group,
            order: preset.prompts.map((prompt, index) => ({
                identifier: prompt.identifier || prompt.name || `__index_${index}`,
                enabled: prompt.enabled !== false,
            })),
        }));
        const payload = {
            ...preset.raw,
            name: preset.name,
            prompts: preset.prompts,
            prompt_order: order,
        };
        try {
            await shareOrDownloadFile({
                content: JSON.stringify(payload, null, 2),
                fileName: `${preset.name.replace(/[<>:"\\/\\\\|?*\\u0000-\\u001F]/g, '_') || 'prompt-preset'}.json`,
                mimeType: 'application/json;charset=utf-8',
                shareTitle: `导出提示词预设「${preset.name}」`,
            });
        } catch (error: any) {
            addToast(error?.message || '导出失败', 'error');
        }
    };

    return (
        <div className="h-full w-full flex flex-col bg-[#f4f7fb] text-slate-800">
            <header className="shrink-0 px-5 pb-4 bg-white/95 border-b border-slate-200/80" style={{ paddingTop: 'max(var(--safe-top, 0px), 14px)' }}>
                <div className="flex items-center justify-between h-11">
                    <button onClick={closeApp} className="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 active:bg-slate-100" aria-label="返回">
                        <ArrowLeft size={20} />
                    </button>
                    <div className="text-center">
                        <div className="text-[10px] tracking-[0.2em] uppercase text-sky-500 font-bold">Prompt Library</div>
                        <h1 className="text-base font-bold text-slate-800">提示词预设</h1>
                    </div>
                    <button onClick={() => importRef.current?.click()} className="w-9 h-9 rounded-full bg-sky-600 text-white flex items-center justify-center shadow-sm active:scale-95" aria-label="导入预设">
                        <UploadSimple size={18} weight="bold" />
                    </button>
                </div>
                <input ref={importRef} type="file" accept=".json,application/json" className="hidden" onChange={importPreset} />
                <p className="text-xs text-slate-500 leading-relaxed mt-2">独立管理酒馆提示词预设。它与世界书分开保存，只把启用的模块注入普通私聊。</p>
            </header>

            <main className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 pb-8 space-y-4">
                <section className="rounded-2xl bg-white border border-slate-200/80 p-4 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400 font-bold">当前生效</div>
                            <div className="font-semibold text-sm mt-1 truncate">{activePreset?.name || '尚未启用预设'}</div>
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center shrink-0"><CheckCircle size={22} weight="duotone" /></div>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-2">{activePreset ? `${activePreset.prompts.filter(item => item.enabled !== false && !item.marker && !!item.content?.trim()).length} 个有效模块` : '导入 JSON 后可在下方启用'}</div>
                </section>

                {presets.length === 0 ? (
                    <section className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-5 py-12 text-center">
                        <div className="text-3xl mb-3">⌘</div>
                        <div className="text-sm font-semibold text-slate-700">还没有提示词预设</div>
                        <p className="text-xs text-slate-400 mt-2 leading-relaxed">导入 SillyTavern / 酒馆的提示词预设 JSON，即可在这里管理模块。</p>
                        <button onClick={() => importRef.current?.click()} className="mt-4 px-4 py-2.5 rounded-xl bg-sky-600 text-white text-xs font-semibold">导入 JSON</button>
                    </section>
                ) : presets.map(preset => (
                    <section key={preset.name} className="rounded-2xl bg-white border border-slate-200/80 shadow-sm overflow-hidden">
                        <div className="p-4">
                            <div className="flex items-start gap-3">
                                <button onClick={() => setExpandedName(expandedName === preset.name ? null : preset.name)} className="flex-1 min-w-0 text-left">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="font-semibold text-sm truncate">{preset.name}</span>
                                        {activeName === preset.name && <span className="shrink-0 text-[9px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-bold">使用中</span>}
                                    </div>
                                    <div className="text-[11px] text-slate-400 mt-1">{preset.prompts.length} 个模块 · {preset.prompt_order.length} 组顺序</div>
                                </button>
                                <button onClick={() => activate(preset.name)} disabled={activeName === preset.name} className="shrink-0 px-3 py-2 rounded-xl bg-sky-50 text-sky-700 text-[11px] font-semibold disabled:bg-emerald-50 disabled:text-emerald-700">
                                    {activeName === preset.name ? '已启用' : '启用'}
                                </button>
                            </div>
                            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100">
                                <button onClick={() => exportPreset(preset)} className="flex-1 py-2 rounded-lg bg-slate-50 text-slate-600 text-[11px] font-medium flex items-center justify-center gap-1.5"><DownloadSimple size={14} />导出</button>
                                <button onClick={() => { setExpandedName(preset.name); setEditingName(editingName === preset.name ? null : preset.name); }} className="flex-1 py-2 rounded-lg bg-slate-50 text-slate-600 text-[11px] font-medium flex items-center justify-center gap-1.5"><PencilSimple size={14} />{editingName === preset.name ? '完成编辑' : '编辑'}</button>
                                <button onClick={() => deletePreset(preset.name)} className="px-3 py-2 rounded-lg bg-rose-50 text-rose-600 text-[11px] font-medium flex items-center justify-center"><Trash size={14} /></button>
                            </div>
                        </div>

                        {expandedName === preset.name && (
                            <div className="border-t border-slate-100 bg-slate-50/70 p-3 space-y-3">
                                {editingName === preset.name && (
                                    <label className="block text-[11px] text-slate-500">预设名称
                                        <input key={preset.name} defaultValue={preset.name} onBlur={event => rename(preset.name, event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800" />
                                    </label>
                                )}
                                {preset.prompts.map((prompt, index) => (
                                    <article key={prompt.identifier || `${prompt.name || 'module'}-${index}`} className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
                                        <div className="flex items-center gap-2">
                                            <input type="checkbox" checked={prompt.enabled !== false} disabled={editingName !== preset.name || !!prompt.marker} onChange={event => updateModule(preset.name, index, { enabled: event.target.checked })} className="w-4 h-4 accent-sky-600" />
                                            <div className="flex-1 min-w-0 text-xs font-semibold text-slate-700 truncate">{prompt.name || prompt.identifier || `模块 ${index + 1}`}</div>
                                            {editingName === preset.name && (
                                                <div className="flex items-center gap-1 shrink-0">
                                                    <button disabled={index === 0} onClick={() => moveModule(preset.name, index, -1)} className="p-1.5 rounded-lg bg-slate-50 text-slate-500 disabled:opacity-30"><ArrowUp size={14} /></button>
                                                    <button disabled={index === preset.prompts.length - 1} onClick={() => moveModule(preset.name, index, 1)} className="p-1.5 rounded-lg bg-slate-50 text-slate-500 disabled:opacity-30"><ArrowDown size={14} /></button>
                                                    {!prompt.marker && <button onClick={() => deleteModule(preset.name, index)} className="p-1.5 rounded-lg bg-rose-50 text-rose-600"><X size={14} /></button>}
                                                </div>
                                            )}
                                        </div>
                                        {editingName === preset.name ? (
                                            <>
                                                <input value={prompt.name || ''} onChange={event => updateModule(preset.name, index, { name: event.target.value })} placeholder="模块名称" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
                                                <input value={prompt.role || 'system'} onChange={event => updateModule(preset.name, index, { role: event.target.value })} placeholder="角色类型" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
                                                <textarea value={typeof prompt.content === 'string' ? prompt.content : ''} onChange={event => updateModule(preset.name, index, { content: event.target.value })} rows={5} placeholder="提示词内容" className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-xs leading-relaxed" />
                                            </>
                                        ) : (
                                            <>
                                                <div className="text-[10px] text-slate-400">{prompt.role || (prompt.system_prompt ? '系统提示词' : '提示词模块')} · {prompt.marker ? '定位标记' : prompt.enabled === false ? '已停用' : '已启用'}</div>
                                                {typeof prompt.content === 'string' && <p className="text-xs text-slate-600 whitespace-pre-wrap break-words line-clamp-5">{prompt.content}</p>}
                                            </>
                                        )}
                                    </article>
                                ))}
                                {editingName === preset.name && <button onClick={() => addModule(preset.name)} className="w-full rounded-xl border border-dashed border-sky-300 py-3 text-xs font-semibold text-sky-700 flex items-center justify-center gap-2"><Plus size={15} />添加模块</button>}
                                <p className="text-[10px] text-slate-400 leading-relaxed">模块开关控制是否注入聊天；编辑状态下可调整顺序、名称、角色和正文。修改会自动保存到本机。</p>
                            </div>
                        )}
                    </section>
                ))}
            </main>
        </div>
    );
};

export default PromptPresetsApp;
