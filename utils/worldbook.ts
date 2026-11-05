import type {
    MountedWorldbook,
    Worldbook,
    WorldbookDepthRole,
    WorldbookPosition,
    WorldbookSelectiveLogic,
} from '../types';

export type WorldbookLike = Worldbook | MountedWorldbook;

export interface WorldbookScanMessage {
    role?: string;
    content: unknown;
}

export interface ResolvedWorldbookEntry {
    book: WorldbookLike;
    content: string;
    position: WorldbookPosition;
    order: number;
}

export interface WorldbookSystemSections {
    beforeCharacter: ResolvedWorldbookEntry[];
    afterCharacter: ResolvedWorldbookEntry[];
    authorsNoteTop: ResolvedWorldbookEntry[];
    authorsNoteBottom: ResolvedWorldbookEntry[];
    atDepth: ResolvedWorldbookEntry[];
    beforeExamples: ResolvedWorldbookEntry[];
    afterExamples: ResolvedWorldbookEntry[];
}

export const WORLDBOOK_POSITION_LABELS: Record<WorldbookPosition, string> = {
    0: '角色设定前',
    1: '角色设定后',
    2: '作者注释顶部',
    3: '作者注释底部',
    4: '聊天记录指定深度',
    5: '示例消息前',
    6: '示例消息后',
};

export const WORLDBOOK_POSITION_DESCRIPTIONS: Record<WorldbookPosition, string> = {
    0: '适合放全局规则、基础背景；会出现在角色身份与性格设定之前。',
    1: '适合一般世界观、人物与地点设定；这是旧版世界书一直使用的默认位置。',
    2: '适合放写作方向、语气或节奏要求；位于作者注释内容顶部。',
    3: '适合放作者注释后的补充与强调；比顶部内容更靠后。',
    4: '适合临时状态、近期事件或强提醒；按深度和角色插入聊天记录。',
    5: '适合放阅读示例对话前需要先知道的说明。',
    6: '适合放示例对话结束后的补充说明。',
};

export const WORLDBOOK_ROLE_LABELS: Record<WorldbookDepthRole, string> = {
    0: 'System',
    1: 'User',
    2: 'Assistant',
};

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const asStringArray = (value: unknown): string[] => {
    const values = Array.isArray(value)
        ? value
        : typeof value === 'string' ? value.split(/[,，\\n]/) : [];
    return values.map(item => String(item).trim()).filter(Boolean);
};

export const splitWorldbookKeywords = (value: string): string[] => (
    value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean)
);

export const toMountedWorldbook = (book: Worldbook): MountedWorldbook => ({
    id: book.id,
    title: book.title,
    content: book.content,
    category: book.category,
    key: book.key ? [...book.key] : undefined,
    keysecondary: book.keysecondary ? [...book.keysecondary] : undefined,
    constant: book.constant,
    selective: book.selective,
    selectiveLogic: book.selectiveLogic,
    order: book.order,
    position: book.position,
    disable: book.disable,
    probability: book.probability,
    useProbability: book.useProbability,
    depth: book.depth,
    role: book.role,
    scanDepth: book.scanDepth,
    caseSensitive: book.caseSensitive,
    matchWholeWords: book.matchWholeWords,
    sourceUid: book.sourceUid,
});

/**
 * Install a complete worldbook group into one character cache. Existing entries
 * with the same ids are replaced, so retrying an install cannot create duplicates.
 */
export const upsertMountedWorldbooks = (
    current: MountedWorldbook[] = [],
    books: Worldbook[] = [],
): MountedWorldbook[] => {
    const incomingIds = new Set(books.map(book => book.id));
    return [
        ...current.filter(book => !incomingIds.has(book.id)),
        ...books.map(toMountedWorldbook),
    ];
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const keywordMatches = (
    text: string,
    keyword: string,
    caseSensitive: boolean,
    wholeWords: boolean,
): boolean => {
    if (!keyword) return false;
    // Word boundaries are not meaningful between CJK characters. Tavern exports can
    // carry matchWholeWords=true even for Chinese/Japanese lorebooks; using Latin-style
    // boundaries there silently prevents ordinary in-sentence keywords from matching.
    const containsCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(keyword);
    if (!wholeWords || containsCjk) {
        return caseSensitive
            ? text.includes(keyword)
            : text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase());
    }
    const flags = caseSensitive ? 'u' : 'iu';
    const escaped = escapeRegExp(keyword);
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, flags).test(text);
};

const messageText = (message: WorldbookScanMessage): string => {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content
            .map(part => (typeof part === 'string' ? part : (part as any)?.text || ''))
            .filter(Boolean)
            .join('\n');
    }
    return '';
};

const scanTextForBook = (book: WorldbookLike, messages: WorldbookScanMessage[]): string => {
    const depth = Math.max(0, Math.floor(book.scanDepth ?? 4));
    if (depth === 0) return '';
    return messages.slice(-depth).map(messageText).filter(Boolean).join('\n');
};

const secondaryConditionPasses = (
    book: WorldbookLike,
    text: string,
    caseSensitive: boolean,
    wholeWords: boolean,
): boolean => {
    if (!book.selective) return true;
    const secondary = book.keysecondary || [];
    if (secondary.length === 0) return true;
    const matches = secondary.map(key => keywordMatches(text, key, caseSensitive, wholeWords));
    const logic: WorldbookSelectiveLogic = book.selectiveLogic ?? 0;
    if (logic === 1) return !matches.every(Boolean);
    if (logic === 2) return !matches.some(Boolean);
    if (logic === 3) return matches.every(Boolean);
    return matches.some(Boolean);
};

export const isWorldbookEntryActive = (
    book: WorldbookLike,
    messages: WorldbookScanMessage[] = [],
): boolean => {
    if (book.disable) return false;

    const primary = book.key || [];
    const isConstant = book.constant ?? primary.length === 0;
    const text = scanTextForBook(book, messages);
    const caseSensitive = book.caseSensitive === true;
    const wholeWords = book.matchWholeWords === true;

    if (!isConstant) {
        if (primary.length === 0) return false;
        if (!primary.some(key => keywordMatches(text, key, caseSensitive, wholeWords))) return false;
        if (!secondaryConditionPasses(book, text, caseSensitive, wholeWords)) return false;
    }

    if (book.useProbability) {
        const probability = clamp(book.probability, 0, 100, 100);
        if (probability <= 0) return false;
        if (probability < 100 && Math.random() * 100 >= probability) return false;
    }

    return true;
};

export const expandWorldbookMacros = (content: string, charName: string, userName: string): string => {
    let expanded = content;
    if (charName) expanded = expanded.replace(/{{\s*char\s*}}/gi, charName);
    if (userName) expanded = expanded.replace(/{{\s*user\s*}}/gi, userName);
    return expanded;
};

export const resolveWorldbookEntries = (
    books: WorldbookLike[] = [],
    messages: WorldbookScanMessage[] = [],
    charName = '',
    userName = '',
): ResolvedWorldbookEntry[] => books
    .filter(book => isWorldbookEntryActive(book, messages))
    .map(book => ({
        book,
        content: expandWorldbookMacros(book.content || '', charName, userName),
        position: book.position ?? 1,
        order: Number.isFinite(book.order) ? Number(book.order) : 100,
    }))
    .filter(entry => entry.content.trim())
    .sort((a, b) => a.order - b.order);

/**
 * 只取「聊天记录指定深度」的条目，交给 injectWorldbookDepthEntries 插进对话。
 * 兼容旧调用方；新 App 使用 ContextBuilder 的完整消息入口，不自行解析或插入世界书。
 */
export const resolveWorldbookDepthEntries = (
    books: WorldbookLike[] = [],
    messages: WorldbookScanMessage[] = [],
    charName = '',
    userName = '',
): ResolvedWorldbookEntry[] => resolveWorldbookEntries(books, messages, charName, userName)
    .filter(entry => entry.position === 4);

export const splitWorldbookSections = (entries: ResolvedWorldbookEntry[]): WorldbookSystemSections => ({
    beforeCharacter: entries.filter(entry => entry.position === 0),
    afterCharacter: entries.filter(entry => entry.position === 1),
    authorsNoteTop: entries.filter(entry => entry.position === 2),
    authorsNoteBottom: entries.filter(entry => entry.position === 3),
    atDepth: entries.filter(entry => entry.position === 4),
    beforeExamples: entries.filter(entry => entry.position === 5),
    afterExamples: entries.filter(entry => entry.position === 6),
});

export const formatWorldbookSection = (
    entries: ResolvedWorldbookEntry[],
    heading: string,
): string => {
    if (entries.length === 0) return '';
    let output = `### ${heading}\n`;
    let lastLegacyCategory = '';
    for (const entry of entries) {
        // SillyTavern comments are editor-only and are not part of the prompt.
        if (entry.book.sourceUid === undefined) {
            const category = entry.book.category || '通用设定 (General)';
            if (category !== lastLegacyCategory) {
                output += `#### [${category}]\n`;
                lastLegacyCategory = category;
            }
            output += `**Title: ${entry.book.title}**\n`;
        }
        output += `${entry.content.trim()}\n---\n`;
    }
    return `${output}\n`;
};

export const injectWorldbookDepthEntries = <T extends WorldbookScanMessage>(
    messages: T[],
    entries: ResolvedWorldbookEntry[],
): Array<T | { role: 'system' | 'user' | 'assistant'; content: string }> => {
    if (entries.length === 0) return [...messages];
    const buckets = new Map<number, ResolvedWorldbookEntry[]>();
    for (const entry of entries) {
        const depth = Math.max(0, Math.floor(entry.book.depth ?? 4));
        const index = Math.max(0, messages.length - depth);
        const bucket = buckets.get(index) || [];
        bucket.push(entry);
        buckets.set(index, bucket);
    }

    const result: Array<T | { role: 'system' | 'user' | 'assistant'; content: string }> = [];
    for (let index = 0; index <= messages.length; index += 1) {
        const bucket = buckets.get(index) || [];
        for (const entry of bucket) {
            const roleValue = entry.book.role ?? 0;
            const role = roleValue === 1 ? 'user' : roleValue === 2 ? 'assistant' : 'system';
            result.push({ role, content: entry.content.trim() });
        }
        if (index < messages.length) result.push(messages[index]);
    }
    return result;
};

export const serializeStandardWorldbook = (books: WorldbookLike[]): string => {
    const usedUids = new Set<number>();
    const entries: Record<string, Record<string, unknown>> = {};

    books.forEach((book, index) => {
        let uid = Number.isFinite(book.sourceUid) ? Number(book.sourceUid) : index;
        while (usedUids.has(uid)) uid += 1;
        usedUids.add(uid);

        const primary = book.key || [];
        const secondary = book.keysecondary || [];
        const position = book.position ?? 1;
        entries[String(index)] = {
            uid,
            key: [...primary],
            keysecondary: [...secondary],
            comment: book.title,
            content: book.content,
            constant: book.constant ?? primary.length === 0,
            selective: book.selective ?? secondary.length > 0,
            selectiveLogic: book.selectiveLogic ?? 0,
            order: book.order ?? 100,
            position,
            disable: book.disable === true,
            probability: book.probability ?? 100,
            useProbability: book.useProbability === true,
            depth: book.depth ?? 4,
            role: position === 4 ? (book.role ?? 0) : null,
            scanDepth: book.scanDepth ?? null,
            caseSensitive: book.caseSensitive ?? null,
            matchWholeWords: book.matchWholeWords ?? null,
            displayIndex: index,
        };
    });

    return JSON.stringify({ entries }, null, 2);
};

export const parseStandardWorldbook = (
    rawText: string,
    category: string,
    now = Date.now(),
): Worldbook[] => {
    let parsed: any;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        throw new Error('JSON 文件无法解析，请确认文件没有损坏');
    }

    // Accept SillyTavern standalone worldbooks, character-card V2/V3
    // character_book containers, and common lorebook wrappers.
    const candidates = [
        parsed,
        parsed?.world_info,
        parsed?.worldbook,
        parsed?.worldBook,
        parsed?.character_book,
        parsed?.characterBook,
        parsed?.data?.character_book,
        parsed?.data?.characterBook,
        parsed?.data?.world_info,
        parsed?.data?.worldbook,
        parsed?.data?.extensions?.world_info,
    ];
    const container = Array.isArray(parsed)
        ? parsed
        : candidates.map(item => item?.entries ?? item?.entry)
            .find(value => Array.isArray(value) || (value && typeof value === 'object'));
    if (!Array.isArray(container) && (!container || typeof container !== 'object')) {
        if (Array.isArray(parsed?.prompts)) {
            throw new Error('检测到这是酒馆「提示词预设」而不是世界书。请到提示词预设导入入口导入，避免把系统提示词误当成世界书条目。');
        }
        throw new Error('不是受支持的世界书 JSON：未找到条目列表。请使用酒馆世界书导出 JSON，或角色卡 V2/V3（character_book）JSON');
    }

    const rawEntries = Array.isArray(container) ? container : Object.values(container);
    const books = rawEntries.flatMap((value: any, index: number): Worldbook[] => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.content !== 'string') return [];
        const sourceId = value.uid ?? value.id;
        const hasUid = sourceId !== undefined && sourceId !== null && sourceId !== '';
        const parsedUid = hasUid ? Number(sourceId) : NaN;
        const uid = Number.isFinite(parsedUid) ? parsedUid : index;
        const primary = asStringArray(value.key ?? value.keys);
        const secondary = asStringArray(value.keysecondary ?? value.secondary_keys ?? value.secondaryKeys);
        const insertionOrder = value.position ?? value.insertion_order ?? value.insertionOrder;
        const positionName = typeof insertionOrder === 'string'
            ? insertionOrder.trim().toLowerCase().replace(/[\s-]+/g, '_')
            : '';
        const positionAliases: Record<string, number> = {
            before: 0, before_char: 0, before_character: 0, world: 0,
            after: 1, after_char: 1, after_character: 1, character: 1,
            top_of_an: 2, authors_note_top: 2, an_top: 2,
            bottom_of_an: 3, authors_note_bottom: 3, an_bottom: 3,
            at_depth: 4, depth: 4,
            before_example: 5, before_examples: 5, example_top: 5,
            after_example: 6, after_examples: 6, example_bottom: 6,
        };
        const rawPosition = typeof insertionOrder === 'string'
            ? positionAliases[positionName] ?? Number(insertionOrder)
            : insertionOrder;

        const position = clamp(rawPosition == null ? undefined : rawPosition, 0, 6, 1) as WorldbookPosition;
        const rawRole = value.role == null ? null : clamp(value.role, 0, 2, 0) as WorldbookDepthRole;
        const rawOrder = value.order == null || value.order === '' ? NaN : Number(value.order);
        return [{
            id: `wb-${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            title: String(value.comment || value.name || value.title || primary[0] || `条目 ${uid + 1}`).trim() || `条目 ${uid + 1}`,
            content: value.content,
            category,
            createdAt: now,
            updatedAt: now,
            key: primary,
            keysecondary: secondary,
            constant: value.constant === true,
            selective: value.selective === true || (value.selective == null && secondary.length > 0),
            selectiveLogic: clamp(value.selectiveLogic == null ? undefined : value.selectiveLogic, 0, 3, 0) as WorldbookSelectiveLogic,
            order: Number.isFinite(rawOrder) ? rawOrder : Number.isFinite(Number(value.insertion_order)) ? Number(value.insertion_order) : 100,
            position,
            disable: value.disable === true || value.enabled === false,
            probability: clamp(value.probability == null ? undefined : value.probability, 0, 100, 100),
            useProbability: value.useProbability === true,
            depth: Math.max(0, Math.floor(clamp(value.depth == null ? undefined : value.depth, 0, 999, 4))),
            role: rawRole,
            scanDepth: value.scanDepth == null ? null : Math.max(0, Math.floor(clamp(value.scanDepth, 0, 999, 4))),
            caseSensitive: value.caseSensitive == null ? null : value.caseSensitive === true,
            matchWholeWords: value.matchWholeWords == null ? null : value.matchWholeWords === true,
            sourceUid: uid,
        }];
    });

    if (books.length === 0) throw new Error('世界书里没有可导入的有效条目，请检查 JSON 是否包含 content 字段');
    return books;
};
