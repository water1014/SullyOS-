import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import JSZip from 'jszip';
import {
  ArrowLeft, ArrowsClockwise, BookOpen, Check, Copy, DownloadSimple, GearSix, ImageSquare,
  Images, MagicWand, Sparkle, Trash,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { deleteBlobRef, getBlobForRef, putImageBlob } from '../utils/blobRef';
import { visualCompanionRepository } from '../utils/visualCompanion/repository';
import { mergeCharacterVisualContextPrompt } from '../utils/visualCompanion/identityPrompt';
import { fetchLlm } from '../utils/anthropicApi';
import {
  formatImageWorldbookContext, matchImageWorldbookEntries, readImageWorldbook,
  IMAGE_WORLDBOOK_STORAGE_KEY, type ImageWorldbookEntry,
} from '../utils/imageStudioWorldbook';
import type { CharacterVisualProfile, VisualTask } from '../utils/visualCompanion/types';
import {
  generateGptImage, editGptImage, generateNaiImage,
  suggestNaiTags, getNaiQualityTags, testGptImageConnection, testNaiImageConnection,
  type GptImageConfig, type NaiImageConfig, type ImageEngine, type ImageConnectionTestResult,
} from '../utils/imageGeneration';

const CONFIG_KEY = 'sully-image-studio:config:v1';
const ITEMS_KEY = 'sully-image-studio:items:v1';
const TEMPLATES_KEY = 'sully-image-studio:nai-templates:v1';
const NAI_SETTINGS_KEY = 'sully-image-studio:nai-settings:v1';
const IMAGE_CATEGORIES = ['未分类', '人物', '场景', '头像', '壁纸', '灵感草稿', '其他'];
const DEFAULT_CONFIG = {
  gpt: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-2.5-flare' },
  naiOfficial: { provider: 'official' as const, baseUrl: 'https://image.novelai.net', apiKey: '', model: 'nai-diffusion-5-full' },
  naiThirdParty: { provider: 'thirdparty' as const, baseUrl: '', apiKey: '', model: 'nai-diffusion-5-full' },
};
type NaiProviderProfile = Pick<NaiImageConfig, 'apiKey' | 'model' | 'baseUrl'>;
type StudioConfig = {
  gpt: GptImageConfig;
  nai: NaiImageConfig;
  naiOfficial: NaiProviderProfile;
  naiThirdParty: NaiProviderProfile;
};
type SavedImage = {
  id: string; blobId: string; engine: ImageEngine; prompt: string; negativePrompt: string;
  requestPrompt?: string; requestNegativePrompt?: string; sceneDescription?: string;
  model: string; createdAt: number; mimeType: string; appearanceProfileVersion?: number;
  naiSettings?: { size: string; steps: number; scale: number; sampler: string; seed?: number };
  note?: string; category?: string; favorite?: boolean; backupSourceId?: string; sourceMessageId?: number;
};
type DisplayImage = SavedImage & { url: string };
type NaiPromptTemplate = { id: string; name: string; prompt: string; negativePrompt: string; createdAt: number };

const readConfig = (): StudioConfig => {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    const legacyNai = saved?.nai || {};
    const naiOfficial = {
      ...DEFAULT_CONFIG.naiOfficial,
      ...(saved?.naiOfficial || (legacyNai.provider !== 'thirdparty' ? legacyNai : {})),
    };
    const naiThirdParty = {
      ...DEFAULT_CONFIG.naiThirdParty,
      ...(saved?.naiThirdParty || (legacyNai.provider === 'thirdparty' ? legacyNai : {})),
    };
    const provider = legacyNai.provider === 'thirdparty' ? 'thirdparty' : 'official';
    return {
      gpt: { ...DEFAULT_CONFIG.gpt, ...(saved?.gpt || {}) },
      naiOfficial,
      naiThirdParty,
      nai: { ...(provider === 'official' ? naiOfficial : naiThirdParty), provider },
    };
  } catch {
    return {
      gpt: DEFAULT_CONFIG.gpt,
      naiOfficial: DEFAULT_CONFIG.naiOfficial,
      naiThirdParty: DEFAULT_CONFIG.naiThirdParty,
      nai: { ...DEFAULT_CONFIG.naiOfficial, provider: 'official' },
    };
  }
};
const readItems = (): SavedImage[] => {
  try {
    const value = JSON.parse(localStorage.getItem(ITEMS_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
};
const persistItems = (items: SavedImage[]) => localStorage.setItem(ITEMS_KEY, JSON.stringify(items));

/** Serialize gallery read-modify-write transactions across tabs where Web Locks is available. */
const updateItemsAtomically = async (
  updater: (current: SavedImage[]) => SavedImage[],
): Promise<SavedImage[]> => {
  const commit = () => {
    const next = updater(readItems());
    persistItems(next);
    return next;
  };
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('sully-image-studio:items-index', { mode: 'exclusive' }, commit);
  }
  return commit();
};
const readNaiSettings = () => {
  const fallback = { size: '832x1216', steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: '' };
  try {
    const saved = JSON.parse(localStorage.getItem(NAI_SETTINGS_KEY) || '{}');
    return {
      size: typeof saved.size === 'string' ? saved.size : fallback.size,
      steps: Number.isFinite(saved.steps) ? Math.min(50, Math.max(10, saved.steps)) : fallback.steps,
      scale: Number.isFinite(saved.scale) ? Math.min(12, Math.max(1, saved.scale)) : fallback.scale,
      sampler: typeof saved.sampler === 'string' ? saved.sampler : fallback.sampler,
      seed: typeof saved.seed === 'string' ? saved.seed : fallback.seed,
    };
  } catch { return fallback; }
};
const readTemplates = (): NaiPromptTemplate[] => {
  try {
    const value = JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
};



type TagCategory = '主体' | '发型' | '眼睛' | '表情' | '服装' | '动作' | '构图' | '场景' | '画风' | '质量';
const NAI_TAGS: Record<TagCategory, string[]> = {
  '主体': ['1girl', '1boy', '2girls', '2boys', 'solo', 'duo', 'multiple girls', 'multiple boys', 'animal', 'cat', 'original'],
  '发型': ['long hair', 'short hair', 'very long hair', 'bob cut', 'ponytail', 'twintails', 'braided hair', 'messy hair', 'wavy hair', 'blunt bangs', 'ahoge'],
  '眼睛': ['blue eyes', 'brown eyes', 'green eyes', 'red eyes', 'golden eyes', 'heterochromia', 'closed eyes', 'looking at viewer'],
  '表情': ['smile', 'gentle smile', 'blush', 'open mouth', 'closed mouth', 'serious', 'shy', 'crying', 'laughing', 'wink'],
  '服装': ['dress', 'school uniform', 'sailor uniform', 'kimono', 'hanfu', 'hoodie', 'sweater', 'white shirt', 'lace dress', 'long sleeves', 'ribbon'],
  '动作': ['standing', 'sitting', 'lying', 'looking back', 'holding', 'walking', 'dancing', 'holding flower', 'holding book', 'hand on own cheek'],
  '构图': ['portrait', 'upper body', 'cowboy shot', 'full body', 'close-up', 'from above', 'from below', 'from behind', 'wide shot', 'dynamic angle', 'depth of field'],
  '场景': ['indoors', 'outdoors', 'flower field', 'garden', 'forest', 'bedroom', 'library', 'cafe', 'city', 'night sky', 'rain', 'sunset', 'moonlight'],
  '画风': ['anime coloring', 'watercolor (medium)', 'ink (medium)', 'pencil sketch', 'soft shading', 'painterly', 'visual novel cg', '3d (medium)', 'muted color', 'pastel colors', 'monochrome'],
  '质量': ['masterpiece', 'very aesthetic', 'best quality', 'amazing quality', 'high complexity', 'no text', 'absurdres'],
};
const TAG_CATEGORIES = Object.keys(NAI_TAGS) as TagCategory[];

const NAI_NEGATIVE_PACKS = [
  { name: '画质瑕疵', tags: ['low quality', 'worst quality', 'lowres', 'blurry', 'jpeg artifacts'] },
  { name: '人体结构', tags: ['bad anatomy', 'bad hands', 'malformed hands', 'extra fingers', 'missing fingers', 'extra limbs', 'fused fingers'] },
  { name: '画面干扰', tags: ['text', 'watermark', 'signature', 'logo', 'cropped', 'out of frame'] },
  { name: '人物瑕疵', tags: ['poorly drawn face', 'asymmetrical eyes', 'deformed', 'duplicate', 'mutation'] },
];

const ImageStudioApp: React.FC = () => {
  const { closeApp, addToast, activeCharacterId, characters, apiConfig } = useOS();
  const [tab, setTab] = useState<'create' | 'gallery' | 'tasks' | 'settings'>('create');
  const [engine, setEngine] = useState<ImageEngine>('gpt');
  const [config, setConfig] = useState<StudioConfig>(readConfig);
  const [prompt, setPrompt] = useState('');
  const [promptMode, setPromptMode] = useState<'manual' | 'ai'>('manual');
  const [aiPrompt, setAiPrompt] = useState('');
  const [enhancingPrompt, setEnhancingPrompt] = useState(false);
  const [imageWorldbook, setImageWorldbook] = useState<ImageWorldbookEntry[]>(readImageWorldbook);
  const [applyImageWorldbook, setApplyImageWorldbook] = useState(true);
  const [worldbookEditorOpen, setWorldbookEditorOpen] = useState(false);
  const [worldbookTitle, setWorldbookTitle] = useState('');
  const [worldbookKeywords, setWorldbookKeywords] = useState('');
  const [worldbookContent, setWorldbookContent] = useState('');
  const [worldbookConstant, setWorldbookConstant] = useState(false);
  const [editingWorldbookId, setEditingWorldbookId] = useState<string | null>(null);
  const [appearanceProfile, setAppearanceProfile] = useState<CharacterVisualProfile | null>(null);
  const [appearanceLoading, setAppearanceLoading] = useState(false);
  const [savingBaseReference, setSavingBaseReference] = useState(false);
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('low quality, worst quality, blurry, bad anatomy');
  const [activeTagCategory, setActiveTagCategory] = useState<TagCategory>('主体');
  const [tagSearch, setTagSearch] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState<{ tag: string; count?: number; confidence?: number }[]>([]);
  const [suggestingTags, setSuggestingTags] = useState(false);
  const [naiTemplates, setNaiTemplates] = useState<NaiPromptTemplate[]>(readTemplates);
  const [templateName, setTemplateName] = useState('');
  const [gptSize, setGptSize] = useState('1024x1024');
  const [gptQuality, setGptQuality] = useState('high');
  const [naiSize, setNaiSize] = useState(() => readNaiSettings().size);
  const [naiSteps, setNaiSteps] = useState(() => readNaiSettings().steps);
  const [naiScale, setNaiScale] = useState(() => readNaiSettings().scale);
  const [naiSampler, setNaiSampler] = useState(() => readNaiSettings().sampler);
  const [naiSeed, setNaiSeed] = useState(() => readNaiSettings().seed);
  const [generating, setGenerating] = useState(false);
  const generationAbortRef = useRef<AbortController | null>(null);
  const [error, setError] = useState('');
  const sharedImageConfig = apiConfig.chatImage;
  const hasSharedImageConfig = !!sharedImageConfig && (sharedImageConfig.engine === 'gpt'
    ? !!(sharedImageConfig.gptBaseUrl || sharedImageConfig.gptApiKey)
    : !!(sharedImageConfig.naiApiKey || sharedImageConfig.naiBaseUrl));
  useEffect(() => {
    if (!hasSharedImageConfig || !sharedImageConfig) return;
    const sharedEngine = sharedImageConfig.engine || 'nai';
    setEngine(sharedEngine);
    setNegativePrompt(sharedEngine === 'nai'
      ? (sharedImageConfig.naiNegativePrompt || 'low quality, worst quality, blurry, bad anatomy')
      : (sharedImageConfig.gptNegativePrompt || ''));
    if (sharedEngine === 'gpt') {
      setConfig(current => ({
        ...current,
        gpt: {
          baseUrl: sharedImageConfig.gptBaseUrl || current.gpt.baseUrl,
          apiKey: sharedImageConfig.gptApiKey || current.gpt.apiKey,
          model: sharedImageConfig.gptModel || current.gpt.model,
          customHeaders: JSON.stringify(sharedImageConfig.gptCustomHeaders || {}),
        },
      }));
      setGptSize(sharedImageConfig.gptSize || '1024x1024');
      setGptQuality(sharedImageConfig.gptQuality || 'high');
    } else {
      const profile = {
        provider: sharedImageConfig.naiProvider || 'official',
        baseUrl: sharedImageConfig.naiProvider === 'thirdparty'
          ? (sharedImageConfig.naiBaseUrl || '')
          : 'https://image.novelai.net',
        apiKey: sharedImageConfig.naiApiKey || '',
        model: sharedImageConfig.naiModel || 'nai-diffusion-5-full',
        customHeaders: JSON.stringify(sharedImageConfig.naiCustomHeaders || {}),
      } as NaiImageConfig;
      setConfig(current => ({
        ...current,
        nai: profile,
        ...(profile.provider === 'official' ? { naiOfficial: profile } : { naiThirdParty: profile }),
      }));
      setNaiSize(`${sharedImageConfig.naiWidth || 832}x${sharedImageConfig.naiHeight || 1216}`);
      setNaiSteps(sharedImageConfig.naiSteps || 28);
      setNaiScale(sharedImageConfig.naiScale || 5);
      setNaiSampler(sharedImageConfig.naiSampler || 'k_euler_ancestral');
      setNaiSeed(sharedImageConfig.naiSeed || '');
    }
  }, [sharedImageConfig]);

  const [images, setImages] = useState<DisplayImage[]>([]);
  const [visualTasks, setVisualTasks] = useState<VisualTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const imagesRef = useRef<DisplayImage[]>([]);
  const [selected, setSelected] = useState<DisplayImage | null>(null);
  const [galleryCategory, setGalleryCategory] = useState('全部');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkCategory, setBulkCategory] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [importProgress, setImportProgress] = useState('');
  const [testingConnection, setTestingConnection] = useState<'gpt' | 'nai' | null>(null);
  const [connectionResult, setConnectionResult] = useState<{ target: 'gpt' | 'nai'; result: ImageConnectionTestResult | null; error?: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    let refreshVersion = 0;
    const hydrate = async () => {
      const version = ++refreshVersion;
      const saved = readItems();
      const hydrated: DisplayImage[] = [];
      for (const item of saved) {
        const blob = await DB.getBlobAsset(item.blobId).catch(() => null);
        if (blob) hydrated.push({ ...item, url: URL.createObjectURL(blob) });
      }
      if (!alive || version !== refreshVersion) {
        hydrated.forEach(item => URL.revokeObjectURL(item.url));
        return;
      }
      const sorted = hydrated.sort((a, b) => b.createdAt - a.createdAt);
      setImages(current => {
        current.forEach(item => URL.revokeObjectURL(item.url));
        return sorted;
      });
      setSelected(current => current ? sorted.find(item => item.id === current.id) || null : null);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === ITEMS_KEY || event.key === null) void hydrate();
    };
    void hydrate();
    window.addEventListener('storage', handleStorage);
    return () => {
      alive = false;
      refreshVersion += 1;
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    if (!activeCharacterId) { setVisualTasks([]); return; }
    setTasksLoading(true);
    void visualCompanionRepository.listTasks(activeCharacterId)
      .then(tasks => { if (alive) setVisualTasks(tasks.sort((a, b) => b.updatedAt - a.updatedAt)); })
      .catch(error => { console.warn('[ImageStudio] task history load failed', error); if (alive) setVisualTasks([]); })
      .finally(() => { if (alive) setTasksLoading(false); });
    return () => { alive = false; };
  }, [activeCharacterId, tab]);

  useEffect(() => {
    let alive = true;
    if (!activeCharacterId) {
      setAppearanceProfile(null);
      setAppearanceLoading(false);
      return;
    }
    setAppearanceLoading(true);
    void visualCompanionRepository.getProfile('visual_profile_' + encodeURIComponent(activeCharacterId))
      .then(profile => { if (alive) setAppearanceProfile(profile); })
      .catch(() => { if (alive) setAppearanceProfile(null); })
      .finally(() => { if (alive) setAppearanceLoading(false); });
    return () => { alive = false; };
  }, [activeCharacterId]);

  useEffect(() => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(naiTemplates));
  }, [naiTemplates]);

  useEffect(() => {
    localStorage.setItem(IMAGE_WORLDBOOK_STORAGE_KEY, JSON.stringify(imageWorldbook));
  }, [imageWorldbook]);

  const matchedImageWorldbook = matchImageWorldbookEntries(imageWorldbook, prompt);
  const imageWorldbookContext = formatImageWorldbookContext(matchedImageWorldbook);

  const resetWorldbookDraft = () => {
    setEditingWorldbookId(null);
    setWorldbookTitle('');
    setWorldbookKeywords('');
    setWorldbookContent('');
    setWorldbookConstant(false);
  };

  const saveImageWorldbookEntry = () => {
    if (!worldbookTitle.trim() || !worldbookContent.trim()) {
      addToast('请填写设定名称和内容', 'error');
      return;
    }
    const entry: ImageWorldbookEntry = {
      id: editingWorldbookId || ('image_wb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
      title: worldbookTitle.trim(),
      keywords: worldbookKeywords.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean),
      content: worldbookContent.trim(),
      enabled: true,
      constant: worldbookConstant,
      updatedAt: Date.now(),
    };
    setImageWorldbook(current => editingWorldbookId
      ? current.map(item => item.id === editingWorldbookId ? entry : item)
      : [entry, ...current]);
    resetWorldbookDraft();
    setWorldbookEditorOpen(false);
    addToast('生图世界书已保存', 'success');
  };

  const editImageWorldbookEntry = (entry: ImageWorldbookEntry) => {
    setEditingWorldbookId(entry.id);
    setWorldbookTitle(entry.title);
    setWorldbookKeywords(entry.keywords.join(', '));
    setWorldbookContent(entry.content);
    setWorldbookConstant(entry.constant);
    setWorldbookEditorOpen(true);
  };

  const enhanceImagePrompt = async () => {
    if (enhancingPrompt || !prompt.trim()) return;
    if (!apiConfig.apiKey?.trim() || !apiConfig.baseUrl?.trim() || !apiConfig.model?.trim()) {
      addToast('请先在聊天 API 设置中配置可用的模型', 'error');
      return;
    }
    setEnhancingPrompt(true);
    setError('');
    try {
      const base = apiConfig.baseUrl.trim().replace(/\/+$/, '');
      const anthropic = apiConfig.apiType === 'anthropic';
      const endpoint = anthropic
        ? (base.endsWith('/messages') ? base : base + '/messages')
        : (base.endsWith('/chat/completions') ? base : base + '/chat/completions');
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (anthropic) {
        headers.set('x-api-key', apiConfig.apiKey);
        headers.set('anthropic-version', '2023-06-01');
      } else {
        headers.set('Authorization', 'Bearer ' + apiConfig.apiKey);
      }
      Object.entries(apiConfig.customHeaders || {}).forEach(([name, value]) => headers.set(name, value));
      const systemPrompt = engine === 'nai'
        ? 'You are an expert NovelAI anime image prompt writer. Convert the user\'s natural-language image idea into a precise, detailed English tag-style positive prompt. Preserve the requested subject, appearance, clothing, pose, composition, lighting, background and mood. Use comma-separated tags and concise descriptive phrases. Do not add unrelated subjects, do not invent identity details, do not include negative prompts, explanations, Markdown or quotes. Output only the finished positive prompt.'
        : 'You are an expert image prompt writer. Convert the user\'s idea into a clear, detailed image-generation prompt. Preserve all requested details and output only the prompt, without explanations or Markdown.';
      const body = anthropic
        ? { model: apiConfig.model, max_tokens: 1200, system: systemPrompt, messages: [{ role: 'user', content: prompt.trim() }] }
        : { model: apiConfig.model, temperature: 0.6, max_tokens: 1200, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt.trim() }] };
      const response = await fetchLlm(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || payload?.error || ('AI 提示词整理失败（HTTP ' + response.status + '）'));
      const result = anthropic
        ? (Array.isArray(payload?.content) ? payload.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('') : '')
        : (payload?.choices?.[0]?.message?.content || '');
      if (typeof result !== 'string' || !result.trim()) throw new Error('AI 没有返回可用的提示词');
      setAiPrompt(result.trim().replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/, ''));
      setPromptMode('ai');
      addToast('AI 提示词已整理好，可以继续编辑', 'success');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'AI 提示词整理失败';
      setError(message);
      addToast(message.slice(0, 80), 'error');
    } finally {
      setEnhancingPrompt(false);
    }
  };

  useEffect(() => {
    localStorage.setItem(NAI_SETTINGS_KEY, JSON.stringify({ size: naiSize, steps: naiSteps, scale: naiScale, sampler: naiSampler, seed: naiSeed }));
  }, [naiSize, naiSteps, naiScale, naiSampler, naiSeed]);

  useEffect(() => {
    if (!referenceImage) { setReferencePreview(''); return; }
    const url = URL.createObjectURL(referenceImage);
    setReferencePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [referenceImage]);

  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => () => imagesRef.current.forEach(item => URL.revokeObjectURL(item.url)), []);

  const testConnection = async (target: 'gpt' | 'nai') => {
    if (testingConnection) return;
    setTestingConnection(target);
    setConnectionResult(null);
    try {
      const result = target === 'gpt'
        ? await testGptImageConnection(config.gpt)
        : await testNaiImageConnection(config.nai);
      setConnectionResult({ target, result });
      addToast(result.ok ? '接口检查完成' : '接口检查发现问题', result.ok ? 'success' : 'error');
    } catch (cause) {
      const message = cause instanceof TypeError
        ? '浏览器无法读取接口响应。请检查网络、HTTPS 证书，以及服务商是否允许当前网页跨域访问（CORS）。'
        : cause instanceof Error ? cause.message : '连接检查失败';
      setConnectionResult({ target, result: null, error: message });
      addToast(message.slice(0, 80), 'error');
    } finally {
      setTestingConnection(null);
    }
  };

  const updateGpt = (updates: Partial<GptImageConfig>) =>
    setConfig(current => ({ ...current, gpt: { ...current.gpt, ...updates } }));
  const updateNai = (updates: Partial<NaiImageConfig>) =>
    setConfig(current => {
      const nai = { ...current.nai, ...updates };
      const profileKey = nai.provider === 'thirdparty' ? 'naiThirdParty' : 'naiOfficial';
      return { ...current, nai, [profileKey]: { ...current[profileKey], ...updates } };
    });
  const switchNaiProvider = (provider: 'official' | 'thirdparty') => {
    setReferenceImage(null);
    setConfig(current => ({
      ...current,
      nai: {
        ...(provider === 'official' ? current.naiOfficial : current.naiThirdParty),
        provider,
      },
    }));
  };

  const addNaiTag = (tag: string) => {
    const existing = prompt.split(',').map(value => value.trim()).filter(Boolean);
    if (existing.some(value => value.toLowerCase() === tag.toLowerCase())) return;
    const isSubject = NAI_TAGS['主体'].includes(tag);
    const next = isSubject ? [tag, ...existing] : [...existing, tag];
    setPrompt(next.join(', '));
  };
  const removeNaiTag = (tag: string) => {
    setPrompt(prompt.split(',').map(value => value.trim()).filter(value => value && value.toLowerCase() !== tag.toLowerCase()).join(', '));
  };
  const promptTags = prompt.split(',').map(value => value.trim()).filter(Boolean);

  const appendPromptTags = (tags: string[]) => {
    const existing = prompt.split(',').map(value => value.trim()).filter(Boolean);
    const seen = new Set(existing.map(value => value.toLowerCase()));
    const additions = tags.filter(tag => {
      const key = tag.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setPrompt([...existing, ...additions].join(', '));
  };

  const addNegativePack = (tags: string[]) => {
    const existing = negativePrompt.split(',').map(value => value.trim()).filter(Boolean);
    const seen = new Set(existing.map(value => value.toLowerCase()));
    const additions = tags.filter(tag => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setNegativePrompt([...existing, ...additions].join(', '));
  };

  const addNaiQualityPreset = (level: 'light' | 'standard') => {
    appendPromptTags(getNaiQualityTags(config.nai.model, level));
    addToast(level === 'light' ? '已追加轻量质量标签' : '已追加标准质量标签', 'success');
  };

  const saveNaiTemplate = () => {
    if (!prompt.trim()) { addToast('先写好提示词，再收藏模板', 'error'); return; }
    const name = templateName.trim() || '灵感模板 ' + (naiTemplates.length + 1);
    const template: NaiPromptTemplate = {
      id: 'template_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name, prompt: prompt.trim(), negativePrompt: negativePrompt.trim(), createdAt: Date.now(),
    };
    setNaiTemplates(current => [template, ...current]);
    setTemplateName('');
    addToast('提示词模板已收藏', 'success');
  };

  const applyNaiTemplate = (template: NaiPromptTemplate) => {
    setPrompt(template.prompt);
    setNegativePrompt(template.negativePrompt);
    addToast('已载入「' + template.name + '」', 'success');
  };

  const deleteNaiTemplate = (id: string) => {
    setNaiTemplates(current => current.filter(template => template.id !== id));
  };
  const generateRandomIdea = () => {
    const pick = (items: string[]) => items[Math.floor(Math.random() * items.length)];
    const categories: TagCategory[] = ['主体', '发型', '眼睛', '表情', '服装', '动作', '构图', '场景', '画风'];
    const idea = categories.map(category => pick(NAI_TAGS[category]));
    idea.push(pick(['masterpiece', 'very aesthetic', 'best quality', 'no text']));
    appendPromptTags(idea);
    addToast('灵感已追加到提示词末尾', 'success');
  };

  const loadNaiSuggestions = async () => {
    if (suggestingTags) return;
    setSuggestingTags(true);
    try {
      const results = await suggestNaiTags(config.nai, tagSearch);
      setTagSuggestions(results.slice(0, 12));
      if (!results.length) addToast('暂时没有找到相关标签', 'success');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '标签建议获取失败';
      setError(message);
      addToast(message.slice(0, 80), 'error');
    } finally {
      setSuggestingTags(false);
    }
  };

  const saveImage = useCallback(async (blob: Blob, generatedSeed?: number, profileVersion?: number, requestPrompt?: string, requestNegativePrompt?: string, usedPrompt?: string) => {
    const id = `studio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const blobId = `image-studio:${id}`;
    await DB.putBlobAsset(blobId, blob);
    const item: SavedImage = {
      id, blobId, engine, prompt: (usedPrompt || prompt).trim(), negativePrompt: engine === 'nai' ? negativePrompt.trim() : '',
      ...(engine === 'nai' && requestPrompt !== undefined ? { requestPrompt, requestNegativePrompt: requestNegativePrompt || '' } : {}),
      model: engine === 'gpt' ? config.gpt.model : config.nai.model,
      ...(profileVersion !== undefined ? { appearanceProfileVersion: profileVersion } : {}),
      ...(engine === 'nai' ? { naiSettings: { size: naiSize, steps: naiSteps, scale: naiScale, sampler: naiSampler, ...(generatedSeed !== undefined ? { seed: generatedSeed } : {}) } } : {}),
      createdAt: Date.now(), mimeType: blob.type || 'image/png',
    };
    try {
      // Keep the metadata index and binary asset consistent. If browser storage
      // is full or unavailable, remove the just-written blob instead of leaving
      // an invisible orphan that looks like a successful generation.
      await updateItemsAtomically(current => [item, ...current]);
    } catch (error) {
      await DB.deleteBlobAsset(blobId).catch(() => undefined);
      throw new Error('图片文件已生成，但画廊索引保存失败。请检查浏览器本地存储空间后重试。', { cause: error });
    }
    const display = { ...item, url: URL.createObjectURL(blob) };
    setImages(current => [display, ...current]);
    setSelected(display);
    setTab('gallery');
  }, [engine, prompt, negativePrompt, config, naiSize, naiSteps, naiScale, naiSampler, naiSeed, activeCharacterId, appearanceProfile]);

  const handleGenerate = async () => {
    if (generating) return;
    const controller = new AbortController();
    generationAbortRef.current = controller;
    setGenerating(true);
    setError('');
    try {
      const currentAppearanceProfile = activeCharacterId
        ? await visualCompanionRepository.getProfile('visual_profile_' + encodeURIComponent(activeCharacterId))
        : appearanceProfile;
      const visualMemories = activeCharacterId
        ? await visualCompanionRepository.listMemories(activeCharacterId)
        : [];
      const sourcePrompt = promptMode === 'ai' ? aiPrompt : prompt;
      if (!sourcePrompt.trim()) throw new Error(promptMode === 'ai' ? '请先生成或填写 AI 提示词' : '请先填写正向提示词');
      const scenePrompt = mergeCharacterVisualContextPrompt(sourcePrompt, currentAppearanceProfile, visualMemories);
      const activeWorldbookContext = applyImageWorldbook ? imageWorldbookContext : '';
      const promptWithWorldbook = activeWorldbookContext
        ? [scenePrompt, activeWorldbookContext].filter(Boolean).join(', ')
        : scenePrompt;
      const fixedPositive = engine === 'nai'
        ? (hasSharedImageConfig ? sharedImageConfig.naiPositivePrompt : '')
        : (hasSharedImageConfig ? sharedImageConfig.gptPositivePrompt : '');
      const fixedSuffix = engine === 'nai'
        ? (hasSharedImageConfig ? sharedImageConfig.naiPositiveSuffix : '')
        : (hasSharedImageConfig ? sharedImageConfig.gptPositiveSuffix : '');
      const effectivePrompt = [fixedPositive, promptWithWorldbook, fixedSuffix].map(part => (part || '').trim()).filter(Boolean).join(', ');
      const effectiveNegativePrompt = hasSharedImageConfig
        ? (engine === 'nai' ? (sharedImageConfig.naiNegativePrompt || negativePrompt) : (sharedImageConfig.gptNegativePrompt || ''))
        : negativePrompt;
      // GPT 生图优先使用用户本次上传的参考图；未上传时回退到角色档案的基础形象图。
      // NAI 保持纯文生图，不把参考图悄悄发送给不支持该流程的接口。
      let effectiveReferenceImage: Blob | File | null = engine === 'gpt' ? referenceImage : null;
      if (engine === 'gpt' && !effectiveReferenceImage && currentAppearanceProfile?.baseAssetId) {
        const baseAsset = await visualCompanionRepository.getAsset(currentAppearanceProfile.baseAssetId);
        if (!baseAsset || baseAsset.charId !== activeCharacterId || baseAsset.status !== 'ready' || baseAsset.privacyScope !== 'standard' || baseAsset.storage.kind !== 'blobref') {
          throw new Error('角色基础形象图片不可用，已停止生成以避免丢失形象锚点');
        }
        const baseBlob = await getBlobForRef(baseAsset.storage.ref);
        if (!baseBlob || !baseBlob.type.startsWith('image/')) {
          throw new Error('角色基础形象图片文件缺失或格式无效');
        }
        effectiveReferenceImage = baseBlob;
      }
      if (engine === 'nai' && (hasSharedImageConfig ? (sharedImageConfig.naiSeed || '') : naiSeed).trim()) {
        const parsedSeed = Number(hasSharedImageConfig ? sharedImageConfig.naiSeed : naiSeed);
        if (!Number.isSafeInteger(parsedSeed) || parsedSeed < 0 || parsedSeed > 4294967295) {
          throw new Error('Seed 必须是 0 到 4294967295 之间的整数，或留空使用随机种子');
        }
      }
      const activeNaiSeed = hasSharedImageConfig ? (sharedImageConfig.naiSeed || '') : naiSeed;
      const effectiveNaiSeed = engine === 'nai'
        ? (activeNaiSeed.trim() ? Number(activeNaiSeed) : Math.floor(Math.random() * 4294967296))
        : undefined;
      if (effectiveNaiSeed !== undefined) setNaiSeed(String(effectiveNaiSeed));
      const activeNaiSize = hasSharedImageConfig
        ? `${sharedImageConfig.naiWidth || 832}x${sharedImageConfig.naiHeight || 1216}`
        : naiSize;
      const naiOptions = {
        width: Number(activeNaiSize.split('x')[0]), height: Number(activeNaiSize.split('x')[1]),
        steps: hasSharedImageConfig ? (sharedImageConfig.naiSteps || 28) : naiSteps,
        scale: hasSharedImageConfig ? (sharedImageConfig.naiScale || 5) : naiScale,
        sampler: hasSharedImageConfig ? (sharedImageConfig.naiSampler || 'k_euler_ancestral') : naiSampler,
        ...(effectiveNaiSeed !== undefined ? { seed: effectiveNaiSeed } : {}),
      };
      const gptNegativeMode = sharedImageConfig?.gptNegativePromptMode || 'append';
      const gptRequestPrompt = engine === 'gpt' && effectiveNegativePrompt && hasSharedImageConfig && gptNegativeMode === 'append'
        ? `${effectivePrompt}. Avoid: ${effectiveNegativePrompt}`
        : effectivePrompt;
      const gptNegativeField = hasSharedImageConfig
        ? (gptNegativeMode === 'field' ? effectiveNegativePrompt : undefined)
        : effectiveNegativePrompt;
      const blob = engine === 'gpt'
        ? effectiveReferenceImage
          ? await editGptImage(config.gpt, effectiveReferenceImage, gptRequestPrompt, { size: gptSize, quality: gptQuality, negativePrompt: gptNegativeField, signal: controller.signal })
          : await generateGptImage(config.gpt, gptRequestPrompt, { size: gptSize, quality: gptQuality, negativePrompt: gptNegativeField, signal: controller.signal })
        : await generateNaiImage(config.nai, effectivePrompt, effectiveNegativePrompt, naiOptions, controller.signal);
      await saveImage(blob, effectiveNaiSeed, currentAppearanceProfile?.status === 'active' ? currentAppearanceProfile.version : undefined, engine === 'nai' ? effectivePrompt.trim() : undefined, engine === 'nai' ? effectiveNegativePrompt.trim() : undefined, sourcePrompt.trim());
      addToast('图片已生成并保存到我的画廊', 'success');
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        setError('本次生成已取消');
        addToast('已取消生成', 'success');
      } else {
        const message = cause instanceof Error ? cause.message : '生成失败，请稍后重试';
        setError(message);
        addToast(message.slice(0, 80), 'error');
      }
    } finally {
      if (generationAbortRef.current === controller) generationAbortRef.current = null;
      setGenerating(false);
    }
  };

  const updateImageMetadata = async (id: string, updates: Partial<Pick<SavedImage, 'note' | 'category' | 'favorite'>>) => {
    try {
      await updateItemsAtomically(current => current.map(item => item.id === id ? { ...item, ...updates } : item));
      setImages(current => current.map(item => item.id === id ? { ...item, ...updates } : item));
      setSelected(current => current?.id === id ? { ...current, ...updates } : current);
    } catch {
      addToast('作品信息保存失败，请检查本地存储空间', 'error');
    }
  };

  const restoreImagePrompt = (item: DisplayImage) => {
    setEngine(item.engine);
    setPrompt(item.prompt);
    setNegativePrompt(item.negativePrompt || '');
    if (item.engine === 'gpt') updateGpt({ model: item.model });
    else {
      updateNai({ model: item.model });
      if (item.naiSettings) {
        setNaiSize(item.naiSettings.size);
        setNaiSteps(item.naiSettings.steps);
        setNaiScale(item.naiSettings.scale);
        setNaiSampler(item.naiSettings.sampler);
        setNaiSeed(item.naiSettings.seed === undefined ? '' : String(item.naiSettings.seed));
      }
    }
    setReferenceImage(null);
    setError('');
    setTab('create');
    addToast('已载入这张作品的提示词和模型', 'success');
  };

  const visibleImages = images.filter(item =>
    (galleryCategory === '全部' || (item.category || '未分类') === galleryCategory) &&
    (!showFavoritesOnly || !!item.favorite)
  );


  const toggleImageSelection = (id: string) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectVisibleImages = () => {
    setSelectedIds(current => {
      const next = new Set(current);
      const allSelected = visibleImages.length > 0 && visibleImages.every(item => next.has(item.id));
      visibleImages.forEach(item => allSelected ? next.delete(item.id) : next.add(item.id));
      return next;
    });
  };

  const exportSelectedImages = async () => {
    const selectedItems = images.filter(item => selectedIds.has(item.id));
    if (!selectedItems.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const zip = new JSZip();
      const manifest: Record<string, unknown>[] = [];
      for (let index = 0; index < selectedItems.length; index += 1) {
        const item = selectedItems[index];
        const blob = await DB.getBlobAsset(item.blobId);
        if (!blob) continue;
        const extension = item.mimeType === 'image/webp' ? 'webp' : item.mimeType === 'image/jpeg' ? 'jpg' : 'png';
        const filename = String(index + 1).padStart(3, '0') + '-' + item.engine + '-' + item.id + '.' + extension;
        zip.file('images/' + filename, blob);
        manifest.push({
          filename: 'images/' + filename, sourceId: item.id, engine: item.engine, model: item.model,
          prompt: item.prompt, negativePrompt: item.negativePrompt, note: item.note || '',
          category: item.category || '未分类', favorite: !!item.favorite,
          createdAt: item.createdAt, mimeType: item.mimeType,
        });
      }
      if (!manifest.length) throw new Error('没有找到可导出的图片文件');
      zip.file('作品清单.json', JSON.stringify({
        format: 'SullyOS Image Studio Backup', version: 1,
        exportedAt: new Date().toISOString(), items: manifest,
      }, null, 2));
      const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 4 } });
      const url = URL.createObjectURL(archive);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = '糯米机-生图室备份-' + new Date().toISOString().slice(0, 10) + '.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Mobile browsers may begin the download after the click handler returns.
      // Keep the object URL alive briefly so the ZIP is not revoked too early.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      addToast('已打包导出 ' + manifest.length + ' 张作品', 'success');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '备份导出失败';
      addToast(message, 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const importImageBackup = async (file: File | null) => {
    if (!file || bulkBusy) return;
    setBulkBusy(true);
    setImportProgress('正在读取备份…');
    try {
      const archive = await JSZip.loadAsync(file);
      const manifestFile = archive.file('作品清单.json');
      if (!manifestFile) throw new Error('备份中没有找到「作品清单.json」');
      const manifest = JSON.parse(await manifestFile.async('text'));
      if (manifest?.format !== 'SullyOS Image Studio Backup' || manifest?.version !== 1 || !Array.isArray(manifest.items)) {
        throw new Error('备份格式不受支持，请选择生图室导出的 ZIP 文件');
      }

      const existing = readItems();
      // An archive exported by this same installation uses item.id as sourceId.
      // Restoring it must be idempotent too, not only archives imported elsewhere.
      const knownSourceIds = new Set(existing.flatMap(item => [item.id, item.backupSourceId]).filter((id): id is string => typeof id === 'string' && !!id));
      const imported: DisplayImage[] = [];
      let skipped = 0;
      let failed = 0;
      for (let index = 0; index < manifest.items.length; index += 1) {
        const record = manifest.items[index];
        setImportProgress(`正在恢复 ${index + 1}/${manifest.items.length}…`);
        if (!record || typeof record.filename !== 'string' || !record.filename.startsWith('images/')) {
          failed += 1;
          continue;
        }
        const sourceId = typeof record.sourceId === 'string' ? record.sourceId : '';
        if (sourceId && knownSourceIds.has(sourceId)) {
          skipped += 1;
          continue;
        }
        const imageFile = archive.file(record.filename);
        if (!imageFile) {
          failed += 1;
          continue;
        }
        try {
          const bytes = await imageFile.async('uint8array');
          if (!bytes.length) { failed += 1; continue; }
          const extension = record.filename.toLowerCase().split('.').pop();
          const mimeType = extension === 'webp' ? 'image/webp' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'png' ? 'image/png' : '';
          if (!mimeType) { failed += 1; continue; }
          const blob = new Blob([bytes], { type: mimeType });
          const id = `studio_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          const blobId = `image-studio:${id}`;
          await DB.putBlobAsset(blobId, blob);
          const item: SavedImage = {
            id, blobId,
            engine: record.engine === 'nai' ? 'nai' : 'gpt',
            prompt: typeof record.prompt === 'string' ? record.prompt : '',
            negativePrompt: typeof record.negativePrompt === 'string' ? record.negativePrompt : '',
            model: typeof record.model === 'string' ? record.model : '',
            createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
            mimeType,
            note: typeof record.note === 'string' ? record.note : '',
            category: IMAGE_CATEGORIES.includes(record.category) ? record.category : '未分类',
            favorite: record.favorite === true,
            ...(sourceId ? { backupSourceId: sourceId } : {}),
          };
          imported.push({ ...item, url: URL.createObjectURL(blob) });
          if (sourceId) knownSourceIds.add(sourceId);
        } catch {
          failed += 1;
        }
      }

      if (imported.length) {
        try {
          await updateItemsAtomically(current => {
            const known = new Set(current.flatMap(item => [item.id, item.backupSourceId]).filter((id): id is string => typeof id === 'string' && !!id));
            const additions = imported
              .map(({ url: _url, ...item }) => item)
              .filter(item => !known.has(item.id) && !(item.backupSourceId && known.has(item.backupSourceId)));
            return [...additions, ...current];
          });
          setImages(current => [...imported, ...current]);
        } catch (error) {
          // Roll back every binary written during this import if the metadata index
          // cannot be committed. Never leave an apparently successful invisible import.
          await Promise.all(imported.map(async item => {
            URL.revokeObjectURL(item.url);
            await DB.deleteBlobAsset(item.blobId).catch(() => undefined);
          }));
          throw new Error('备份图片已读取，但画廊索引保存失败。已回滚本次导入，请检查本地存储空间。', { cause: error });
        }
      }
      setSelected(null);
      setSelectionMode(false);
      setSelectedIds(new Set());
      addToast(`备份恢复完成：导入 ${imported.length} 张，跳过重复 ${skipped} 张，失败 ${failed} 张`, imported.length || skipped ? 'success' : 'error');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '备份导入失败';
      addToast(message, 'error');
    } finally {
      setBulkBusy(false);
      setImportProgress('');
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const applyBulkCategory = async () => {
    if (!bulkCategory || selectedIds.size === 0) return;
    const ids = new Set(selectedIds);
    const category = bulkCategory;
    try {
      await updateItemsAtomically(current => current.map(item => ids.has(item.id) ? { ...item, category } : item));
      setImages(current => current.map(item => ids.has(item.id) ? { ...item, category } : item));
      setSelected(current => current && ids.has(current.id) ? { ...current, category } : current);
      addToast('已为 ' + ids.size + ' 张作品设置分类', 'success');
      setBulkCategory('');
    } catch {
      addToast('批量分类保存失败，请检查本地存储空间', 'error');
    }
  };

  const deleteSelectedImages = async () => {
    const targets = images.filter(item => selectedIds.has(item.id));
    if (!targets.length || bulkBusy || !window.confirm('确定删除选中的 ' + targets.length + ' 张作品吗？此操作无法撤销。')) return;
    setBulkBusy(true);
    const snapshots: Array<{ item: DisplayImage; blob: Blob }> = [];
    const removed: DisplayImage[] = [];
    try {
      // Snapshot every binary before deleting anything. A missing blob is treated
      // as a failed item, never as permission to erase its metadata.
      for (const item of targets) {
        const blob = await DB.getBlobAsset(item.blobId).catch(() => null);
        if (!blob) continue;
        snapshots.push({ item, blob });
      }

      for (const snapshot of snapshots) {
        try {
          if (!snapshot.item.sourceMessageId) await DB.deleteBlobAsset(snapshot.item.blobId);
          removed.push(snapshot.item);
        } catch {
          // Keep this item in the gallery when its binary could not be deleted.
        }
      }

      const removedIds = new Set(removed.map(item => item.id));
      if (removedIds.size) {
        try {
          // Commit the metadata only after the binary deletions have completed.
          await updateItemsAtomically(current => current.filter(item => !removedIds.has(item.id)));
        } catch (error) {
          // Restore every binary if the index commit fails, so the visible
          // gallery and its metadata remain usable.
          const restoreResults = await Promise.all(removed.map(async item => {
            const snapshot = snapshots.find(entry => entry.item.id === item.id);
            if (!snapshot) return false;
            try { await DB.putBlobAsset(item.blobId, snapshot.blob); return true; }
            catch { return false; }
          }));
          const restored = restoreResults.filter(Boolean).length;
          addToast(
            restored === removed.length
              ? '批量删除未完成，图片文件已恢复，作品记录保持不变'
              : `批量删除未完成，已恢复 ${restored}/${removed.length} 张图片，请立即导出备份并检查本地存储`,
            'error',
          );
          return;
        }

        setImages(current => current.filter(item => !removedIds.has(item.id)));
        setSelected(current => current && removedIds.has(current.id) ? null : current);
        removed.forEach(item => URL.revokeObjectURL(item.url));
      }

      const failed = targets.length - removed.length;
      setSelectedIds(new Set());
      addToast(
        failed
          ? `删除完成：成功 ${removed.length} 张，失败 ${failed} 张，失败作品已保留`
          : '已删除 ' + removed.length + ' 张作品',
        failed ? 'error' : 'success',
      );
    } catch (error) {
      addToast(error instanceof Error ? error.message : '批量删除失败，作品记录已保留', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const setSelectedAsBaseReference = async (item: DisplayImage) => {
    if (!activeCharacterId || savingBaseReference) return;
    setSavingBaseReference(true);
    let blobRef: string | null = null;
    let assetId: string | null = null;
    try {
      const blob = await DB.getBlobAsset(item.blobId);
      if (!blob || !blob.type.startsWith('image/')) throw new Error('这张作品的图片文件不可用，无法设为固定参考图');
      blobRef = await putImageBlob(blob);
      assetId = 'visual_asset_gallery_' + encodeURIComponent(activeCharacterId) + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await visualCompanionRepository.saveAsset({
        id: assetId,
        charId: activeCharacterId,
        status: 'ready',
        privacyScope: 'standard',
        storage: { kind: 'blobref', ref: blobRef },
        mimeType: blob.type || item.mimeType || 'image/png',
        byteSize: blob.size,
        createdAt: Date.now(),
      });

      const profileId = 'visual_profile_' + encodeURIComponent(activeCharacterId);
      const current = await visualCompanionRepository.getProfile(profileId);
      const now = Date.now();
      const next: CharacterVisualProfile = {
        id: profileId,
        charId: activeCharacterId,
        version: current ? current.version + 1 : 1,
        status: current?.status || 'draft',
        identity: current?.identity || [],
        anchorPrompt: current?.anchorPrompt || '',
        baseAssetId: assetId,
        ...(current?.confirmedAt ? { confirmedAt: current.confirmedAt } : {}),
        createdAt: current?.createdAt || now,
        updatedAt: now,
      };
      await visualCompanionRepository.saveProfile(next);
      setAppearanceProfile(next);
      addToast('已设为当前角色的固定参考图，GPT 生图会优先使用它', 'success');
    } catch (cause) {
      if (assetId) await visualCompanionRepository.deleteAsset(assetId).catch(() => undefined);
      if (blobRef) await deleteBlobRef(blobRef).catch(() => undefined);
      addToast(cause instanceof Error ? cause.message : '设置固定参考图失败', 'error');
    } finally {
      setSavingBaseReference(false);
    }
  };

  const deleteImage = async (item: DisplayImage) => {
    if (!window.confirm('确定删除这张作品吗？')) return;
    const originalBlob = await DB.getBlobAsset(item.blobId).catch(() => null);
    try {
      if (originalBlob && !item.sourceMessageId) await DB.deleteBlobAsset(item.blobId);
      await updateItemsAtomically(current => current.filter(saved => saved.id !== item.id));
      setImages(current => current.filter(saved => saved.id !== item.id));
      if (selected?.id === item.id) setSelected(null);
      URL.revokeObjectURL(item.url);
      addToast('作品已删除', 'success');
    } catch (error) {
      // If metadata could not be updated after deleting the binary, restore the
      // original blob so the still-visible gallery entry remains usable.
      if (originalBlob) await DB.putBlobAsset(item.blobId, originalBlob).catch(() => undefined);
      addToast('删除未能完整提交，已尽力恢复图片文件；作品记录仍保留，请稍后重试', 'error');
    }
  };

  const downloadImage = async (item: DisplayImage) => {
    const extension = item.mimeType === 'image/webp' ? 'webp' : item.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const filename = `nuomi-${item.engine}-${new Date(item.createdAt).toISOString().slice(0, 10)}.${extension}`;
    try {
      if (Capacitor.isNativePlatform()) {
        // Android WebView does not reliably honor <a download> for blob: URLs.
        // Materialize the original image blob to app cache, then hand its file URI
        // to the native share sheet so the user can save it to Downloads/Photos.
        const response = await fetch(item.url);
        if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）`);
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result || '');
            const base64 = result.includes(',') ? result.slice(result.indexOf(',') + 1) : '';
            if (!base64) reject(new Error('图片编码失败'));
            else resolve(base64);
          };
          reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
          reader.readAsDataURL(blob);
        });
        const saved = await Filesystem.writeFile({
          path: `sullyos-exports/${Date.now()}-${filename}`,
          data: dataUrl,
          directory: Directory.Cache,
          recursive: true,
        });
        await Share.share({
          title: '保存生图作品',
          text: filename,
          files: [saved.uri],
          dialogTitle: '保存图片',
        });
        addToast('已打开系统分享面板，可选择保存到设备或文件', 'success');
        return;
      }
      const anchor = document.createElement('a');
      anchor.href = item.url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      addToast('已开始下载图片', 'success');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '图片下载失败';
      addToast(`图片下载失败：${message.slice(0, 100)}`, 'error');
    }
  };

  const copyPrompt = async (value: string) => {
    try { await navigator.clipboard.writeText(value); addToast('提示词已复制', 'success'); }
    catch { addToast('复制失败，请长按文字手动复制', 'error'); }
  };

  const engineLabel = engine === 'gpt' ? 'OpenAI 兼容生图' : config.nai.provider === 'official' ? 'NovelAI 官方' : 'NAI 第三方';
  const configured = engine === 'gpt' ? !!config.gpt.apiKey.trim() : !!config.nai.apiKey.trim() && (config.nai.provider === 'official' || !!config.nai.baseUrl.trim());

  return (
    <div className="sully-image-studio h-full w-full overflow-hidden flex flex-col text-slate-800">
      <style>{`
        .sully-image-studio{background:radial-gradient(ellipse at 10% 0%,rgba(186,230,253,.78),transparent 42%),linear-gradient(155deg,#f5faff 0%,#eaf3fb 48%,#f7f9fc 100%);--studio-ink:#20364b;--studio-muted:#8193a6;--studio-line:rgba(126,158,187,.22)}
        .sully-image-studio *{box-sizing:border-box}
        .sully-image-studio .glass{background:rgba(255,255,255,.66);border:1px solid rgba(255,255,255,.82);box-shadow:0 12px 34px rgba(57,91,125,.08),inset 0 1px rgba(255,255,255,.85);backdrop-filter:blur(22px)}
        .sully-image-studio .field{width:100%;border:1px solid var(--studio-line);background:rgba(255,255,255,.72);border-radius:14px;padding:12px 13px;color:#24384b;outline:none;font-size:13px}
        .sully-image-studio .field:focus{border-color:#8ab8dc;box-shadow:0 0 0 3px rgba(120,174,214,.14)}
        .sully-image-studio .tab{display:flex;align-items:center;justify-content:center;gap:7px;padding:10px 12px;border-radius:13px;font-size:12px;font-weight:700;color:#7d91a5}
        .sully-image-studio .tab.active{background:rgba(255,255,255,.88);color:#315b7e;box-shadow:0 4px 14px rgba(49,91,126,.09)}
        .sully-image-studio .primary{background:linear-gradient(135deg,#467da8,#6e9fc3);color:white;box-shadow:0 9px 22px rgba(62,115,157,.22)}
        .sully-image-studio .primary:disabled{opacity:.48;box-shadow:none}
        .sully-image-studio .soft{background:rgba(255,255,255,.72);border:1px solid var(--studio-line);color:#55718a}
        .sully-image-studio button{transition:transform .16s ease,background .16s ease}
        .sully-image-studio button:active{transform:scale(.98)}
        .sully-image-studio .studio-scroll{overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
        .sully-image-studio .art-tile{background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.9);box-shadow:0 6px 18px rgba(44,77,107,.08)}
      `}</style>
      <header className="shrink-0 px-4 pt-3 pb-3">
        <div className="flex items-center justify-between mb-4">
          <button onClick={closeApp} className="soft w-9 h-9 rounded-full flex items-center justify-center" aria-label="返回"><ArrowLeft size={18}/></button>
          <div className="text-center">
            <div className="text-[10px] tracking-[.28em] text-sky-700/60 font-semibold">NUOMI CREATIVE LAB</div>
            <div className="text-[19px] font-semibold tracking-[.08em] text-slate-700">生图室</div>
          </div>
          <button onClick={() => setTab('settings')} className={`w-9 h-9 rounded-full flex items-center justify-center ${tab === 'settings' ? 'primary' : 'soft'}`} aria-label="设置"><GearSix size={18}/></button>
        </div>
        <div className="glass rounded-[18px] p-1.5 grid grid-cols-3 gap-1">
          <button className={`tab ${tab === 'create' ? 'active' : ''}`} onClick={() => setTab('create')}><MagicWand size={15}/>创作台</button>
          <button className={`tab ${tab === 'gallery' ? 'active' : ''}`} onClick={() => setTab('gallery')}><Images size={15}/>我的画廊 <span className="text-[10px] opacity-65">{images.length}</span></button>
          <button className={`tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}><ArrowsClockwise size={15}/>任务记录 <span className="text-[10px] opacity-65">{visualTasks.length}</span></button>
          <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}><GearSix size={15}/>引擎配置</button>
        </div>
      </header>

      {tab === 'create' && (
        <main className="studio-scroll flex-1 px-4 pb-6 space-y-4">
          <section className="glass rounded-[24px] p-4">
            <div className="flex items-center justify-between mb-3">
              <div><div className="text-[10px] tracking-[.2em] text-sky-700/55 font-bold">CHOOSE ENGINE</div><div className="text-sm font-semibold text-slate-700 mt-1">选择创作引擎</div></div>
              <Sparkle size={21} className="text-sky-500"/>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button onClick={() => setEngine('gpt')} className={`rounded-2xl p-2.5 text-left border ${engine === 'gpt' ? 'bg-sky-50 border-sky-300 ring-2 ring-sky-100' : 'bg-white/55 border-white'}`}>
                <div className="flex items-center justify-between gap-1"><span className="text-xs font-bold text-slate-700">OpenAI 兼容</span>{engine === 'gpt' && <Check size={13} className="text-sky-600"/>}</div>
                <div className="text-[9px] text-slate-500 mt-1">第三方兼容接口</div>
              </button>
              <button onClick={() => { setEngine('nai'); switchNaiProvider('thirdparty'); }} className={`rounded-2xl p-2.5 text-left border ${engine === 'nai' && config.nai.provider === 'thirdparty' ? 'bg-sky-50 border-sky-300 ring-2 ring-sky-100' : 'bg-white/55 border-white'}`}>
                <div className="flex items-center justify-between gap-1"><span className="text-xs font-bold text-slate-700">NAI 第三方</span>{engine === 'nai' && config.nai.provider === 'thirdparty' && <Check size={13} className="text-sky-600"/>}</div>
                <div className="text-[9px] text-slate-500 mt-1">自定义代理地址</div>
              </button>
              <button onClick={() => { setEngine('nai'); switchNaiProvider('official'); }} className={`rounded-2xl p-2.5 text-left border ${engine === 'nai' && config.nai.provider === 'official' ? 'bg-sky-50 border-sky-300 ring-2 ring-sky-100' : 'bg-white/55 border-white'}`}>
                <div className="flex items-center justify-between gap-1"><span className="text-xs font-bold text-slate-700">NAI 官方</span>{engine === 'nai' && config.nai.provider === 'official' && <Check size={13} className="text-sky-600"/>}</div>
                <div className="text-[9px] text-slate-500 mt-1">官方原生接口</div>
              </button>
            </div>
            <div className="flex items-center gap-2 mt-3 text-[10px] text-slate-500"><span className={`w-1.5 h-1.5 rounded-full ${configured ? 'bg-emerald-400' : 'bg-amber-400'}`}/>{configured ? `${engineLabel} 已填写 API Key` : `${engineLabel} 尚未配置密钥`}<button onClick={() => setTab('settings')} className="ml-auto text-sky-700 font-semibold">去配置 →</button></div>
          </section>

          <section className="glass rounded-[24px] p-4 space-y-3">
            <div className="flex items-center justify-between"><div><div className="text-[10px] tracking-[.2em] text-sky-700/55 font-bold">YOUR IMAGINATION</div><div className="text-sm font-semibold mt-1">描述你想要的画面</div></div><span className="text-[10px] text-slate-400">PROMPT</span></div>
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-600">你的原始描述 / 正向提示词</label>
              <textarea className="field min-h-[132px] resize-y leading-6" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={engine === 'gpt' ? (referenceImage ? '描述你希望如何修改这张参考图……' : '例如：雨后的玻璃花房，蓝色月光落在白色花瓣上，电影感构图……') : '可以直接填写中文或英文提示词，例如：masterpiece, 1girl, ...'} />
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setPromptMode('manual')} className={`rounded-xl py-2.5 text-[11px] font-semibold border ${promptMode === 'manual' ? 'bg-sky-600 text-white border-sky-600' : 'bg-white/75 text-slate-600 border-sky-100'}`}>直接使用我的提示词</button>
                <button type="button" onClick={() => setPromptMode('ai')} className={`rounded-xl py-2.5 text-[11px] font-semibold border ${promptMode === 'ai' ? 'bg-sky-600 text-white border-sky-600' : 'bg-white/75 text-slate-600 border-sky-100'}`}>让 AI 整理成提示词</button>
              </div>
              {promptMode === 'ai' && <div className="rounded-2xl border border-sky-100 bg-sky-50/60 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2"><div className="text-xs font-semibold text-slate-700">AI 提示词草稿</div><button type="button" disabled={enhancingPrompt || !prompt.trim()} onClick={() => void enhanceImagePrompt()} className="primary rounded-xl px-3 py-2 text-[10px] font-semibold disabled:opacity-50">{enhancingPrompt ? '整理中…' : aiPrompt ? '重新整理' : 'AI 帮我写'}</button></div>
                <textarea className="field min-h-[120px] resize-y leading-6" value={aiPrompt} onChange={event => setAiPrompt(event.target.value)} placeholder="点击「AI 帮我写」，生成后也可以在这里自行修改。"/>
                <p className="text-[10px] text-slate-500">使用聊天 API 配置的模型整理，不会自动发送生图；确认内容后再点击生成。</p>
              </div>}
            </div>
            <section className="rounded-2xl border border-sky-100 bg-white/60 p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2"><BookOpen size={17} className="text-sky-600"/><div><div className="text-xs font-semibold text-slate-700">生图世界书</div><div className="text-[10px] text-slate-400">独立于聊天世界书，按关键词自动注入</div></div></div>
                <button type="button" onClick={() => { resetWorldbookDraft(); setWorldbookEditorOpen(value => !value); }} className="soft rounded-xl px-3 py-2 text-[10px] font-semibold">{worldbookEditorOpen ? '收起' : '管理设定'}</button>
              </div>
              <label className="flex items-center gap-2 text-[10px] text-slate-600"><input type="checkbox" checked={applyImageWorldbook} onChange={event => setApplyImageWorldbook(event.target.checked)}/>本次生图应用世界书设定</label>
              <div className="text-[10px] text-slate-500">当前命中 {matchedImageWorldbook.length} 条设定{matchedImageWorldbook.length ? '：' + matchedImageWorldbook.map(item => item.title).join('、') : '。填写提示词关键词后自动匹配；常驻条目始终生效。'}</div>
              {worldbookEditorOpen && <>
                <div className="space-y-2 rounded-xl bg-sky-50/70 p-3">
                  <div className="text-xs font-semibold text-slate-700">{editingWorldbookId ? '编辑生图设定' : '新增生图设定'}</div>
                  <input className="field" value={worldbookTitle} onChange={event => setWorldbookTitle(event.target.value)} placeholder="设定名称，例如：宋祁的固定外貌"/>
                  <input className="field" value={worldbookKeywords} onChange={event => setWorldbookKeywords(event.target.value)} placeholder="触发关键词，用逗号分隔；留空则仅常驻生效"/>
                  <textarea className="field min-h-[100px] resize-y" value={worldbookContent} onChange={event => setWorldbookContent(event.target.value)} placeholder="填写希望生图时遵守的外貌、服装、画风、场景规则…"/>
                  <label className="flex items-center gap-2 text-[11px] text-slate-600"><input type="checkbox" checked={worldbookConstant} onChange={event => setWorldbookConstant(event.target.checked)}/>常驻设定，每次生图都注入</label>
                  <div className="flex gap-2"><button type="button" onClick={saveImageWorldbookEntry} className="primary flex-1 rounded-xl py-2.5 text-xs font-semibold">保存设定</button><button type="button" onClick={resetWorldbookDraft} className="soft rounded-xl px-3 py-2 text-xs">清空</button></div>
                </div>
                {imageWorldbook.length > 0 ? <div className="space-y-2">{imageWorldbook.map(entry => <div key={entry.id} className="flex items-start gap-2 rounded-xl border border-sky-50 bg-white/75 p-3">
                  <div className="min-w-0 flex-1"><div className="text-xs font-semibold text-slate-700">{entry.title}</div><div className="text-[10px] text-slate-400 mt-1">{entry.constant ? '常驻' : entry.keywords.join('、') || '未设置触发词'} · {entry.enabled ? '启用' : '停用'}</div><div className="text-[10px] text-slate-500 mt-1 line-clamp-2">{entry.content}</div></div>
                  <button type="button" onClick={() => setImageWorldbook(current => current.map(item => item.id === entry.id ? {...item, enabled: !item.enabled} : item))} className="text-[10px] text-sky-700">{entry.enabled ? '停用' : '启用'}</button>
                  <button type="button" onClick={() => editImageWorldbookEntry(entry)} className="text-[10px] text-slate-600">编辑</button>
                  <button type="button" onClick={() => setImageWorldbook(current => current.filter(item => item.id !== entry.id))} className="text-[10px] text-rose-500">删除</button>
                </div>)}</div> : <p className="text-[10px] text-slate-400">还没有生图设定，可以先添加角色外貌、服装和画风规则。</p>}
              </>}
            </section>{engine === 'gpt' && <div className="space-y-2"><label className="block text-xs font-semibold text-slate-600">负向提示词 <span className="font-normal text-slate-400">· 可选</span></label><textarea className="field min-h-[84px] resize-y leading-6" value={negativePrompt} onChange={event => setNegativePrompt(event.target.value)} placeholder="填写希望避免的内容，例如：模糊、文字、水印、畸形结构……" /></div>}
            {activeCharacterId && (
              <div className="rounded-xl border border-sky-100 bg-sky-50/70 px-3 py-2 text-[11px] text-sky-800 flex items-center gap-2">
                <Sparkle size={14}/>
                <span className="min-w-0 flex-1">{appearanceLoading ? '正在读取人物外貌档案…' : appearanceProfile?.status === 'active' ? `已连接 ${characters.find(character => character.id === activeCharacterId)?.name || '当前角色'} 的人物外貌，生图时自动注入` : '当前角色尚未启用人物外貌档案，可在记忆宫殿「人物外貌」中设置'}</span>
              </div>
            )}
            {engine === 'gpt' && (
              <div className="rounded-2xl border border-dashed border-sky-200 bg-sky-50/55 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div><div className="text-xs font-semibold text-slate-700">参考图编辑 <span className="font-normal text-slate-400">· 可选</span></div><p className="text-[10px] text-slate-400 mt-1">上传图片后，GPT 会按上方描述修改它</p></div>
                  {referenceImage && <button type="button" onClick={() => setReferenceImage(null)} className="text-[10px] text-rose-500 font-semibold">移除图片</button>}
                </div>
                {referencePreview ? (
                  <div className="flex items-center gap-3">
                    <img src={referencePreview} alt="参考图预览" className="w-20 h-20 rounded-xl object-cover border border-white shadow-sm"/>
                    <div className="min-w-0"><div className="text-xs text-slate-600 truncate">{referenceImage?.name}</div><div className="text-[10px] text-slate-400 mt-1">{((referenceImage?.size || 0) / 1024 / 1024).toFixed(1)} MB</div></div>
                  </div>
                ) : (
                  <label className="flex items-center justify-center gap-2 rounded-xl bg-white/75 border border-white py-3 text-xs font-semibold text-sky-700 cursor-pointer">
                    <ImageSquare size={16}/>选择一张参考图片
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      if (file.size > 20 * 1024 * 1024) { setError('参考图片不能超过 20 MB'); event.target.value = ''; return; }
                      setError('');
                      setReferenceImage(file);
                      event.target.value = '';
                    }}/>
                  </label>
                )}
              </div>
            )}
            {engine === 'nai' && <>
              <div className="rounded-2xl border border-sky-100 bg-white/55 p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div><div className="text-xs font-semibold text-slate-700">标签灵感库</div><p className="text-[10px] text-slate-400 mt-1">点选标签加入提示词，重复标签会自动跳过</p></div>
                  <button type="button" onClick={() => setPrompt('')} className="text-[10px] text-slate-400">清空提示词</button>
                </div>
                <div className="flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
                  {TAG_CATEGORIES.map(category => <button key={category} type="button" onClick={() => setActiveTagCategory(category)} className={`shrink-0 rounded-full px-3 py-1.5 text-[10px] font-semibold ${activeTagCategory === category ? 'bg-sky-600 text-white' : 'bg-white/80 text-slate-500 border border-slate-100'}`}>{category}</button>)}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {NAI_TAGS[activeTagCategory].map(tag => {
                    const added = promptTags.some(value => value.toLowerCase() === tag.toLowerCase());
                    return <button key={tag} type="button" onClick={() => added ? removeNaiTag(tag) : addNaiTag(tag)} className={`rounded-lg px-2.5 py-1.5 text-[10px] border ${added ? 'bg-sky-100 border-sky-200 text-sky-800' : 'bg-white/75 border-white text-slate-600'}`}>{added ? '✓ ' : '+ '}{tag}</button>;
                  })}
                </div>
                {promptTags.length > 0 && <div className="border-t border-sky-100 pt-2"><div className="text-[10px] text-slate-400 mb-2">已加入 · {promptTags.length}</div><div className="flex flex-wrap gap-1.5">{promptTags.map((tag, index) => <button key={`${tag}-${index}`} type="button" onClick={() => removeNaiTag(tag)} className="rounded-lg bg-sky-50 text-sky-800 px-2 py-1 text-[10px]">{tag} ×</button>)}</div></div>}
                <div className="border-t border-sky-100 pt-3 space-y-2">
                  <div className="flex items-center justify-between gap-2"><div><div className="text-xs font-semibold text-slate-700">官方标签联想</div><p className="text-[10px] text-slate-400 mt-1">{config.nai.provider === 'official' ? '连接 NovelAI 官方标签库，按当前模型推荐' : '第三方接口不一定开放官方标签联想'}</p></div><span className="text-[9px] text-sky-700">NAI</span></div>
                  <div className="flex gap-2">
                    <input className="field min-w-0 flex-1" value={tagSearch} onChange={event => setTagSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && config.nai.provider === 'official') void loadNaiSuggestions(); }} placeholder="输入标签片段，例如 blue hair" disabled={config.nai.provider !== 'official'}/>
                    <button type="button" disabled={suggestingTags || !tagSearch.trim() || config.nai.provider !== 'official'} onClick={() => void loadNaiSuggestions()} className="primary rounded-xl px-3 text-[11px] font-semibold disabled:opacity-50">{config.nai.provider !== 'official' ? '官方专属' : suggestingTags ? '查询中' : '联想'}</button>
                  </div>
                  {tagSuggestions.length > 0 && <div className="flex flex-wrap gap-1.5">{tagSuggestions.map(item => <button key={item.tag} type="button" onClick={() => addNaiTag(item.tag)} className="rounded-lg border border-sky-100 bg-sky-50/80 px-2.5 py-1.5 text-[10px] text-sky-800">＋ {item.tag}</button>)}</div>}
                </div>
                <div className="border-t border-sky-100 pt-3 space-y-2">
                  <div className="text-xs font-semibold text-slate-700">模型专属质量标签</div>
                  <p className="text-[10px] text-slate-400">按当前模型追加推荐组合，不会覆盖已有内容</p>
                  {config.nai.model.startsWith("nai-diffusion-5") ? <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => addNaiQualityPreset("light")} className="soft rounded-xl py-2 text-[11px] font-semibold">＋ 轻量质量</button>
                    <button type="button" onClick={() => addNaiQualityPreset("standard")} className="soft rounded-xl py-2 text-[11px] font-semibold">＋ 标准质量</button>
                  </div> : <button type="button" onClick={() => addNaiQualityPreset("standard")} className="soft w-full rounded-xl py-2 text-[11px] font-semibold">＋ 追加当前模型官方质量组合</button>}
                </div>
                <button type="button" onClick={generateRandomIdea} className="w-full soft rounded-xl py-2.5 text-xs font-semibold flex items-center justify-center gap-2"><Sparkle size={14}/>随机灵感组合 <span className="text-[10px] font-normal opacity-65">· 只追加，不覆盖原提示词</span></button>
                <div className="border-t border-sky-100 pt-3 space-y-2">
                  <div className="flex items-center justify-between"><div className="text-xs font-semibold text-slate-700">我的提示词模板</div><span className="text-[10px] text-slate-400">{naiTemplates.length} 个已收藏</span></div>
                  <div className="flex gap-2">
                    <input className="field min-w-0 flex-1" value={templateName} onChange={event => setTemplateName(event.target.value)} placeholder="给这组提示词起个名字"/>
                    <button type="button" onClick={saveNaiTemplate} disabled={!prompt.trim()} className="primary rounded-xl px-3 text-[11px] font-semibold disabled:opacity-50">收藏</button>
                  </div>
                  {naiTemplates.length > 0 ? <div className="space-y-1.5">{naiTemplates.map(template => <div key={template.id} className="flex items-center gap-2 rounded-xl bg-white/70 border border-sky-50 px-3 py-2">
                    <button type="button" onClick={() => applyNaiTemplate(template)} className="min-w-0 flex-1 text-left"><div className="text-[11px] font-semibold text-slate-700 truncate">{template.name}</div><div className="text-[9px] text-slate-400 truncate mt-0.5">{template.prompt}</div></button>
                    <button type="button" onClick={() => deleteNaiTemplate(template.id)} className="text-[10px] text-rose-400 px-1.5 py-1">删除</button>
                  </div>)}</div> : <p className="text-[10px] text-slate-400">收藏后的模板会保存在本机，可以随时载入。</p>}
                </div>
              </div>
              <div className="flex items-center justify-between"><label className="text-xs font-semibold text-slate-600">反向提示词</label><button onClick={() => copyPrompt(negativePrompt)} className="text-[10px] text-sky-700 flex items-center gap-1"><Copy size={12}/>复制</button></div>
              <textarea className="field min-h-[76px] resize-y leading-5" value={negativePrompt} onChange={event => setNegativePrompt(event.target.value)} placeholder="不希望出现在画面中的内容……"/>
              <div className="space-y-2">
                <div className="text-[10px] font-semibold text-slate-500">负面标签快捷包 · 点击追加</div>
                <div className="flex flex-wrap gap-1.5">{NAI_NEGATIVE_PACKS.map(pack => <button key={pack.name} type="button" onClick={() => addNegativePack(pack.tags)} className="rounded-lg border border-rose-100 bg-rose-50/70 text-rose-700 px-2.5 py-1.5 text-[10px]">＋ {pack.name}</button>)}</div>
              </div>
            </>}
          </section>

          <section className="glass rounded-[24px] p-4 space-y-3">
            <div className="text-[10px] tracking-[.2em] text-sky-700/55 font-bold">GENERATION SETTINGS</div>
            {engine === 'gpt' ? <>
              <label className="block text-xs font-semibold text-slate-600">画面比例</label>
              <div className="grid grid-cols-3 gap-2">
                {[['1024x1024','1:1 方形'],['1536x1024','3:2 横向'],['1024x1536','2:3 竖向']].map(([value,label]) => <button key={value} onClick={() => setGptSize(value)} className={`rounded-xl py-2 text-[11px] border ${gptSize === value ? 'bg-sky-50 border-sky-300 text-sky-800' : 'bg-white/55 border-white text-slate-500'}`}>{label}</button>)}
              </div>
              <label className="block text-xs font-semibold text-slate-600">生成质量</label>
              <select className="field" value={gptQuality} onChange={event => setGptQuality(event.target.value)}><option value="low">快速预览 · Low</option><option value="medium">标准 · Medium</option><option value="high">高质量 · High</option></select>
              <p className="text-[10px] text-slate-400">当前模型：{config.gpt.model}</p>
            </> : <>
              <label className="block text-xs font-semibold text-slate-600">画面尺寸</label>
              <select className="field" value={naiSize} onChange={event => setNaiSize(event.target.value)}><option value="832x1216">竖向 832 × 1216</option><option value="1216x832">横向 1216 × 832</option><option value="1024x1024">方形 1024 × 1024</option><option value="768x1344">长竖幅 768 × 1344</option><option value="1344x768">长横幅 1344 × 768</option></select>
              <div><div className="flex justify-between text-xs font-semibold text-slate-600"><span>迭代步数 Steps</span><span>{naiSteps}</span></div><input className="w-full accent-sky-600 mt-2" type="range" min="10" max="50" value={naiSteps} onChange={event => setNaiSteps(Number(event.target.value))}/></div>
              <div><div className="flex justify-between text-xs font-semibold text-slate-600"><span>提示词引导 Scale</span><span>{naiScale.toFixed(1)}</span></div><input className="w-full accent-sky-600 mt-2" type="range" min="1" max="12" step=".5" value={naiScale} onChange={event => setNaiScale(Number(event.target.value))}/></div>
              <label className="block text-xs font-semibold text-slate-600">采样器</label>
              <select className="field" value={naiSampler} onChange={event => setNaiSampler(event.target.value)}><option value="k_euler_ancestral">Euler Ancestral · 推荐</option><option value="k_dpmpp_2m">DPM++ 2M · 推荐</option><option value="k_euler">Euler</option><option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option><option value="k_dpmpp_sde">DPM++ SDE</option><option value="k_dpm_2">DPM2</option><option value="k_dpm_fast">DPM Fast</option><option value="k_heun">Heun</option><option value="ddim">DDIM</option></select>
              <div className="space-y-1"><label className="block text-xs font-semibold text-slate-600">随机种子 Seed <span className="font-normal text-slate-400">· 留空为随机</span></label><input className="field" type="number" inputMode="numeric" min="0" max="4294967295" step="1" value={naiSeed} onChange={event => setNaiSeed(event.target.value)} placeholder="留空自动随机生成"/><p className="text-[10px] text-slate-400">固定种子并保持模型、尺寸、提示词和参数一致，可帮助复现相近构图。</p></div>
              <div className="flex gap-2"><button type="button" className="soft flex-1 rounded-xl py-2 text-[11px] font-semibold" onClick={() => { setNaiSize('832x1216'); setNaiSteps(28); setNaiScale(5); setNaiSampler('k_euler_ancestral'); setNaiSeed(''); }}>恢复推荐参数</button><button type="button" className="soft flex-1 rounded-xl py-2 text-[11px] font-semibold" onClick={() => setNaiSeed(String(Math.floor(Math.random() * 4294967295)))}>随机生成 Seed</button></div>
              <p className="text-[10px] text-slate-400">当前模型：{config.nai.model} · 文生图 · 参数自动保存在本机</p>
            </>}
          </section>

          {error && <div className="rounded-2xl border border-rose-200 bg-rose-50/90 p-3 text-xs text-rose-700 leading-5">{error}</div>}
          <button onClick={handleGenerate} disabled={generating || !configured || !(promptMode === 'manual' ? prompt.trim() : aiPrompt.trim())} className="primary w-full rounded-2xl py-4 flex items-center justify-center gap-2 text-sm font-bold">
            {generating ? <><ArrowsClockwise size={18} className="animate-spin"/>{referenceImage && engine === 'gpt' ? '正在编辑参考图…' : '正在绘制，请稍候…'}</> : <><Sparkle size={18}/>{referenceImage && engine === 'gpt' ? '开始编辑图片' : '开始生成'}</>}
          </button>
          {generating && <button onClick={() => generationAbortRef.current?.abort()} className="soft w-full rounded-xl py-2.5 text-xs font-semibold text-rose-600">取消本次生成</button>}
          <p className="text-center text-[10px] text-slate-400">生成费用由对应平台收取 · 作品只保存在本机设备</p>
        </main>
      )}

      {tab === 'gallery' && (
        <main className="studio-scroll flex-1 px-4 pb-6">
          <input ref={importInputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={event => void importImageBackup(event.target.files?.[0] || null)}/>
          <div className="flex justify-end py-2">
            <button onClick={() => importInputRef.current?.click()} disabled={bulkBusy} className="soft rounded-full px-3 py-2 text-[10px] font-semibold disabled:opacity-50">
              {bulkBusy && importProgress ? importProgress : '导入 ZIP 备份'}
            </button>
          </div>
          {selected ? (
            <div className="space-y-3">
              <button onClick={() => setSelected(null)} className="soft rounded-full px-3 py-2 text-xs flex items-center gap-1"><ArrowLeft size={14}/>返回作品列表</button>
              <div className="glass rounded-[24px] p-2"><img src={selected.url} className="w-full max-h-[58vh] object-contain rounded-[18px]" alt="生成作品"/></div>
              <div className="glass rounded-[20px] p-4 space-y-2">
                <div className="flex items-center justify-between"><span className="text-xs font-bold text-slate-700">{selected.engine === 'gpt' ? 'GPT Image' : 'NovelAI'} · {selected.model}</span><span className="text-[10px] text-slate-400">{new Date(selected.createdAt).toLocaleString()}</span></div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-slate-600">作品分类</label>
                  <select className="field max-w-[170px] py-2" value={selected.category || '未分类'} onChange={event => updateImageMetadata(selected.id, { category: event.target.value })}>{IMAGE_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}</select>
                </div>
                <label className="block text-xs font-semibold text-slate-600">作品备注</label>
                <textarea className="field min-h-[70px] resize-y" value={selected.note || ''} onChange={event => updateImageMetadata(selected.id, { note: event.target.value })} placeholder="记录创作想法、修改方向或灵感来源……"/>
                <div className="flex items-center justify-between"><label className="text-xs font-semibold text-slate-600">正向提示词</label><button onClick={() => copyPrompt(selected.prompt)} className="text-[10px] text-sky-700">复制</button></div>
                <p className="text-xs leading-5 text-slate-600 whitespace-pre-wrap break-words rounded-xl bg-white/55 p-3">{selected.prompt}</p>
                {selected.sourceMessageId && selected.sceneDescription && <details className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-3 space-y-2">
                  <summary className="cursor-pointer text-xs font-semibold text-indigo-800">聊天生图诊断记录</summary>
                  <div className="space-y-1"><label className="text-[10px] font-semibold text-slate-600">聊天模型交给生图工具的场景描述</label><p className="text-[11px] leading-5 text-slate-700 whitespace-pre-wrap break-words">{selected.sceneDescription}</p></div>
                  <div className="flex items-center justify-between gap-2"><label className="text-[10px] font-semibold text-slate-600">最终交给图像接口的正向提示词</label><button type="button" onClick={() => copyPrompt(selected.requestPrompt || selected.prompt)} className="text-[10px] text-indigo-700">复制</button></div>
                  <p className="text-[11px] leading-5 text-slate-700 whitespace-pre-wrap break-words">{selected.requestPrompt || selected.prompt}</p>
                  {(selected.requestNegativePrompt || selected.negativePrompt) && <><div className="flex items-center justify-between gap-2"><label className="text-[10px] font-semibold text-slate-600">最终负向提示词</label><button type="button" onClick={() => copyPrompt(selected.requestNegativePrompt || selected.negativePrompt)} className="text-[10px] text-indigo-700">复制</button></div><p className="text-[11px] leading-5 text-slate-600 whitespace-pre-wrap break-words">{selected.requestNegativePrompt || selected.negativePrompt}</p></>}
                </details>}
                {selected.engine === 'nai' && selected.requestPrompt && <details className="rounded-xl border border-sky-100 bg-sky-50/60 p-3 space-y-2">
                  <summary className="cursor-pointer text-xs font-semibold text-sky-800">查看实际发送给 NAI 的完整提示词</summary>
                  <div className="flex items-center justify-between gap-2"><label className="text-[10px] font-semibold text-slate-600">最终正向提示词（含角色外貌与固定前后缀）</label><button type="button" onClick={() => copyPrompt(selected.requestPrompt || '')} className="text-[10px] text-sky-700">复制</button></div>
                  <p className="text-[11px] leading-5 text-slate-700 whitespace-pre-wrap break-words">{selected.requestPrompt}</p>
                  {selected.requestNegativePrompt && <><div className="flex items-center justify-between gap-2"><label className="text-[10px] font-semibold text-slate-600">最终负向提示词</label><button type="button" onClick={() => copyPrompt(selected.requestNegativePrompt || '')} className="text-[10px] text-sky-700">复制</button></div><p className="text-[11px] leading-5 text-slate-600 whitespace-pre-wrap break-words">{selected.requestNegativePrompt}</p></>}
                </details>}
                {activeCharacterId && <p className="text-[10px] leading-4 text-sky-700 bg-sky-50/70 rounded-xl px-3 py-2">可将这张作品设为当前角色的固定参考图。该图片仅在 GPT / OpenAI 兼容图像编辑流程中作为图像参考，NAI 仍使用文字形象描述。</p>}
                {selected.negativePrompt && <>
                  <div className="flex items-center justify-between"><label className="text-xs font-semibold text-slate-600">反向提示词</label><button onClick={() => copyPrompt(selected.negativePrompt)} className="text-[10px] text-sky-700">复制</button></div>
                  <p className="text-xs leading-5 text-slate-500 whitespace-pre-wrap break-words rounded-xl bg-white/45 p-3">{selected.negativePrompt}</p>
                </>}
                {selected.engine === 'nai' && selected.naiSettings && <div className="rounded-xl bg-sky-50/70 border border-sky-100 p-3 space-y-1"><div className="text-[10px] font-semibold text-sky-800">本次生成参数</div><p className="text-[10px] text-slate-600">{selected.naiSettings.size} · {selected.naiSettings.steps} Steps · Scale {selected.naiSettings.scale} · {selected.naiSettings.sampler}</p><div className="flex items-center justify-between gap-2"><span className="text-[10px] text-slate-500">Seed：{selected.naiSettings.seed ?? '随机'}</span>{selected.naiSettings.seed !== undefined && <button type="button" onClick={() => copyPrompt(String(selected.naiSettings?.seed))} className="text-[10px] text-sky-700">复制 Seed</button>}</div></div>}
              <div className="grid grid-cols-2 gap-2 pt-1">
                  <button onClick={() => restoreImagePrompt(selected)} className="primary rounded-xl py-2.5 text-xs font-semibold">载入提示词继续创作</button>
                  <button onClick={() => updateImageMetadata(selected.id, { favorite: !selected.favorite })} className="soft rounded-xl py-2.5 text-xs">{selected.favorite ? '★ 已收藏' : '☆ 收藏作品'}</button>
                  {activeCharacterId && <button disabled={savingBaseReference} onClick={() => void setSelectedAsBaseReference(selected)} className="soft col-span-2 rounded-xl py-2.5 text-xs font-semibold disabled:opacity-50">{savingBaseReference ? '正在保存固定参考图…' : '✧ 设为当前角色的固定参考图'}</button>}
                  <button onClick={() => downloadImage(selected)} className="soft rounded-xl py-2.5 text-xs flex items-center justify-center gap-1"><DownloadSimple size={14}/>下载图片</button>
                  <button onClick={() => deleteImage(selected)} className="soft rounded-xl py-2.5 text-rose-500 flex items-center justify-center gap-1"><Trash size={14}/>删除作品</button>
                </div>
              </div>
            </div>
          ) : images.length ? (
            <>

              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-[11px] text-slate-500">共 {images.length} 张作品</div>
                <button onClick={() => { setSelectionMode(value => !value); setSelectedIds(new Set()); }} className={selectionMode ? 'primary rounded-full px-3 py-2 text-[10px] font-semibold' : 'soft rounded-full px-3 py-2 text-[10px] font-semibold'}>{selectionMode ? '退出多选' : '批量管理'}</button>
              </div>
              {selectionMode && <div className="glass rounded-2xl p-3 mb-3 space-y-2">
                <div className="flex items-center justify-between"><span className="text-xs font-semibold text-slate-700">已选择 {selectedIds.size} 张</span><button onClick={selectVisibleImages} className="text-[10px] text-sky-700 font-semibold">全选当前筛选</button></div>
                <div className="grid grid-cols-2 gap-2">
                  <button disabled={!selectedIds.size || bulkBusy} onClick={() => void exportSelectedImages()} className="primary rounded-xl py-2.5 text-[11px] font-semibold disabled:opacity-50">{bulkBusy ? '处理中…' : '打包导出 ZIP'}</button>
                  <button disabled={!selectedIds.size || bulkBusy} onClick={() => void deleteSelectedImages()} className="soft rounded-xl py-2.5 text-[11px] font-semibold text-rose-600 disabled:opacity-50">批量删除</button>
                </div>
                <div className="flex gap-2">
                  <select className="field min-w-0 flex-1 py-2" value={bulkCategory} onChange={event => setBulkCategory(event.target.value)}><option value="">批量设置分类…</option>{IMAGE_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}</select>
                  <button disabled={!selectedIds.size || !bulkCategory} onClick={applyBulkCategory} className="soft rounded-xl px-3 text-[10px] font-semibold disabled:opacity-50">应用</button>
                </div>
              </div>}
              <div className="flex gap-2 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
                {['全部', ...IMAGE_CATEGORIES].map(category => <button key={category} onClick={() => setGalleryCategory(category)} className={galleryCategory === category ? 'shrink-0 rounded-full px-3 py-2 text-[10px] font-semibold primary' : 'shrink-0 rounded-full px-3 py-2 text-[10px] font-semibold soft'}>{category}</button>)}
                <button onClick={() => setShowFavoritesOnly(value => !value)} className={showFavoritesOnly ? 'shrink-0 rounded-full px-3 py-2 text-[10px] font-semibold primary' : 'shrink-0 rounded-full px-3 py-2 text-[10px] font-semibold soft'}>{showFavoritesOnly ? '★ 仅收藏' : '☆ 收藏'}</button>
              </div>
              {visibleImages.length ? <div className="grid grid-cols-2 gap-3">
                {visibleImages.map(item => <div key={item.id} className={selectionMode && selectedIds.has(item.id) ? 'art-tile rounded-[18px] p-1.5 relative ring-2 ring-sky-400' : 'art-tile rounded-[18px] p-1.5 relative'}>
                  <button onClick={() => selectionMode ? toggleImageSelection(item.id) : setSelected(item)} className="w-full text-left relative"><img src={item.url} alt="生成作品" loading="lazy" className="w-full aspect-[3/4] object-cover rounded-[13px]"/>{item.favorite && <span className="absolute top-2 right-2 rounded-full bg-white/90 px-2 py-1 text-[10px] text-amber-600">★</span>}{selectionMode && <span className={selectedIds.has(item.id) ? 'absolute top-2 left-2 w-6 h-6 rounded-full border-2 flex items-center justify-center text-xs bg-sky-600 border-sky-600 text-white' : 'absolute top-2 left-2 w-6 h-6 rounded-full border-2 flex items-center justify-center text-xs bg-white/90 border-white text-transparent'}>✓</span>}<div className="px-1.5 py-2"><div className="text-[10px] font-semibold text-slate-600 truncate">{item.engine === 'gpt' ? 'GPT Image' : 'NovelAI'} · {item.category || '未分类'}</div><div className="text-[9px] text-slate-400 mt-1">{new Date(item.createdAt).toLocaleDateString()}</div>{item.note && <div className="text-[9px] text-slate-500 mt-1 truncate">{item.note}</div>}</div></button>
                </div>)}
              </div> : <div className="glass rounded-2xl p-6 text-center text-xs text-slate-400">这个筛选条件下还没有作品。</div>}
            </>
          ) : (
            <div className="glass rounded-[26px] min-h-[300px] flex flex-col items-center justify-center text-center p-7">
              <div className="w-16 h-16 rounded-[22px] bg-sky-100/80 flex items-center justify-center text-sky-600 mb-4"><ImageSquare size={30}/></div>
              <div className="text-sm font-semibold text-slate-700">这里还空着</div><p className="text-xs text-slate-400 leading-5 mt-2">第一张作品完成后，就会收藏在这里。</p>
              <button onClick={() => setTab('create')} className="primary rounded-full px-5 py-2.5 mt-5 text-xs font-semibold">去创作一张</button>
            </div>
          )}
        </main>
      )}

      {tab === 'tasks' && (
        <main className="studio-scroll flex-1 px-4 pb-6 space-y-3">
          <section className="glass rounded-[22px] p-4">
            <div className="text-sm font-bold text-slate-700">视觉任务记录</div>
            <p className="text-[10px] text-slate-500 leading-5 mt-1">记录宋祁主动分享与视觉任务的执行状态。这里仅展示本机 IndexedDB 中的任务，不会上传任务内容。</p>
          </section>
          {tasksLoading ? <div className="glass rounded-2xl p-6 text-center text-xs text-slate-400">正在读取任务记录…</div>
            : visualTasks.length ? visualTasks.map(task => {
              const statusLabels: Record<VisualTask['status'], string> = {
                queued: '排队中', planning: '准备中', awaiting_approval: '等待确认',
                generating: '生成中', persisting: '保存中', delivery_pending: '待投递',
                delivered: '已完成', retry_wait: '等待重试', cancelled: '已取消', failed: '失败',
              };
              const safeToRetry = task.status === 'failed';
              return <article key={task.id} className="glass rounded-2xl p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-700">{task.kind === 'spontaneous_share' ? '宋祁主动分享' : task.kind === 'chat_requested' ? '聊天生图' : task.kind === 'photo_project' ? '写真项目' : '视觉创作'}</div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] ${task.status === 'failed' ? 'bg-rose-50 text-rose-600' : task.status === 'delivered' ? 'bg-emerald-50 text-emerald-700' : 'bg-sky-50 text-sky-700'}`}>{statusLabels[task.status]}</span>
                </div>
                <div className="text-[10px] text-slate-400">{new Date(task.createdAt).toLocaleString()} · {task.provider === 'openai_compatible' || task.provider === 'openai' ? 'GPT' : 'NovelAI'} · {task.model}</div>
                {task.errorMessage && <p className="rounded-xl bg-rose-50/70 p-3 text-[10px] leading-5 text-rose-700 break-words">{task.errorMessage}</p>}
                {task.status === 'retry_wait' && <p className="text-[10px] text-amber-700">计划重试：{task.nextAttemptAt ? new Date(task.nextAttemptAt).toLocaleString() : '等待调度'}</p>}
                {task.status === 'generating' && <p className="text-[10px] text-amber-700">如果页面曾意外关闭，系统不会自动重复发起这次生成，以免产生重复费用。</p>}
                <div className="text-[9px] text-slate-400">任务编号：{task.id}</div>
              </article>;
            }) : <div className="glass rounded-2xl p-7 text-center text-xs text-slate-400">暂时没有视觉任务记录。</div>}
          <button type="button" onClick={() => setTab('create')} className="soft w-full rounded-xl py-3 text-xs font-semibold">返回创作台</button>
        </main>
      )}

      {tab === 'settings' && (
        <main className="studio-scroll flex-1 px-4 pb-6 space-y-4">
          <section className="glass rounded-[24px] p-4 space-y-3">
            <div><div className="text-[10px] tracking-[.2em] text-sky-700/55 font-bold">ENGINE 01</div><div className="text-base font-semibold mt-1">OpenAI 兼容生图接口</div></div>
            <label className="block text-xs font-semibold text-slate-600">API Base URL</label>
            <input className="field" value={config.gpt.baseUrl} onChange={event => updateGpt({baseUrl:event.target.value})} placeholder="https://api.openai.com/v1"/>
            <label className="block text-xs font-semibold text-slate-600">API Key</label>
            <input className="field" type="password" autoComplete="off" value={config.gpt.apiKey} onChange={event => updateGpt({apiKey:event.target.value})} placeholder="sk-..."/>
            <label className="block text-xs font-semibold text-slate-600">图片模型名称</label>
            <input className="field" value={config.gpt.model} onChange={event => updateGpt({model:event.target.value})} placeholder="填写服务商支持的图片模型，例如 gpt-image-1"/>
            <label className="block text-xs font-semibold text-slate-600">自定义请求头 · JSON（可选）</label>
            <textarea className="field min-h-[76px] resize-y font-mono text-[11px]" value={config.gpt.customHeaders || ''} onChange={event => updateGpt({customHeaders:event.target.value})} placeholder={'{"x-api-key":"自定义值","x-provider":"provider-name"}'}/>
            <p className="text-[10px] text-slate-400 leading-5">GPT API Key 与自定义请求头保存在当前设备浏览器的本地存储中，不会上传到糯米机服务器。请勿在公共设备上保存密钥。</p>
            <button type="button" onClick={() => void testConnection('gpt')} disabled={testingConnection !== null} className="soft w-full rounded-xl py-2.5 text-xs font-semibold disabled:opacity-50">{testingConnection === 'gpt' ? '正在检查接口…' : '测试 GPT 接口'}</button>
            {connectionResult?.target === 'gpt' && <div className={`rounded-xl p-3 text-[10px] leading-5 ${connectionResult.result?.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-700'}`}>{connectionResult.result?.message || connectionResult.error}{connectionResult.result?.status ? ` · HTTP ${connectionResult.result.status}` : ''}{connectionResult.result ? ` · ${connectionResult.result.durationMs} ms` : ''}</div>}
          </section>
          <section className="glass rounded-[24px] p-4 space-y-3">
            <div><div className="text-[10px] tracking-[.2em] text-sky-700/55 font-bold">ENGINE 02 / 03</div><div className="text-base font-semibold mt-1">NovelAI 接口配置</div></div>
            <label className="block text-xs font-semibold text-slate-600">NAI 接口类型</label>
            <p className="text-[10px] text-slate-400 leading-5">官方与第三方分别保存各自的 Token、模型和地址，切换接口不会覆盖另一套配置。</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => switchNaiProvider('official')} className={`rounded-xl border py-2.5 text-xs font-semibold ${config.nai.provider === 'official' ? 'bg-sky-50 border-sky-300 text-sky-800' : 'bg-white/60 border-white text-slate-500'}`}>官方接口</button>
              <button type="button" onClick={() => switchNaiProvider('thirdparty')} className={`rounded-xl border py-2.5 text-xs font-semibold ${config.nai.provider === 'thirdparty' ? 'bg-sky-50 border-sky-300 text-sky-800' : 'bg-white/60 border-white text-slate-500'}`}>第三方 / 代理</button>
            </div>
            {config.nai.provider === 'thirdparty' && <>
              <label className="block text-xs font-semibold text-slate-600">第三方 API Base URL</label>
              <input className="field" value={config.nai.baseUrl} onChange={event => updateNai({baseUrl:event.target.value})} placeholder="https://your-provider.example"/>
              <p className="text-[10px] text-slate-400 leading-5">填写支持 NovelAI 原生生图协议的第三方地址。系统会在地址后补全 /ai/generate-image；若服务协议不同，需另外开发适配器。</p>
            </>}
            <label className="block text-xs font-semibold text-slate-600">{config.nai.provider === 'official' ? 'NovelAI Persistent Token' : '第三方 API Token'}</label>
            <input className="field" type="password" autoComplete="off" value={config.nai.apiKey} onChange={event => updateNai({apiKey:event.target.value})} placeholder={config.nai.provider === 'official' ? 'pst-...' : '填写服务商提供的 Token'}/>
            <label className="block text-xs font-semibold text-slate-600">图片模型</label>
            {config.nai.provider === 'official' ? (
              <select className="field" value={config.nai.model} onChange={event => updateNai({model:event.target.value})}><option value="nai-diffusion-5-full">NovelAI Diffusion V5 Full</option><option value="nai-diffusion-5-curated">NovelAI Diffusion V5 Curated</option><option value="nai-diffusion-4-5-full">NovelAI Diffusion V4.5 Full</option><option value="nai-diffusion-4-5-curated">NovelAI Diffusion V4.5 Curated</option></select>
            ) : (
              <input className="field" value={config.nai.model} onChange={event => updateNai({model:event.target.value})} placeholder="填写第三方服务支持的模型 ID"/>
            )}
            <label className="block text-xs font-semibold text-slate-600">自定义请求头 · JSON（可选）</label>
            <textarea className="field min-h-[76px] resize-y font-mono text-[11px]" value={config.nai.customHeaders || ''} onChange={event => updateNai({customHeaders:event.target.value})} placeholder={'{"x-api-key":"自定义值","x-provider":"provider-name"}'}/>
            <p className="text-[10px] text-slate-400 leading-5">Token 与自定义请求头保存在当前设备浏览器本地存储中，不会写入作品记录。第三方服务的模型名称和参数以服务商实际支持为准。</p>
            <button type="button" onClick={() => void testConnection('nai')} disabled={testingConnection !== null} className="soft w-full rounded-xl py-2.5 text-xs font-semibold disabled:opacity-50">{testingConnection === 'nai' ? '正在检查接口…' : config.nai.provider === 'official' ? '验证 NovelAI Token' : '检查第三方地址'}</button>
            {connectionResult?.target === 'nai' && <div className={`rounded-xl p-3 text-[10px] leading-5 ${connectionResult.result?.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-700'}`}>{connectionResult.result?.message || connectionResult.error}{connectionResult.result?.status ? ` · HTTP ${connectionResult.result.status}` : ''}{connectionResult.result ? ` · ${connectionResult.result.durationMs} ms` : ''}</div>}
          </section>
          <div className="rounded-2xl bg-sky-50/80 border border-sky-100 p-3 text-[10px] text-sky-800 leading-5">接口说明：OpenAI 兼容服务需要支持 /images/generations（参考图编辑还需 /images/edits）；NAI 第三方当前按 NovelAI 原生请求协议接入；NAI 官方使用 image.novelai.net。第三方服务是否支持浏览器跨域访问，取决于服务商设置。</div>
          <button onClick={() => { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); addToast('生图引擎配置已保存', 'success'); }} className="primary w-full rounded-2xl py-3 text-sm font-bold">保存配置</button>
        </main>
      )}
    </div>
  );
};

export default ImageStudioApp;
