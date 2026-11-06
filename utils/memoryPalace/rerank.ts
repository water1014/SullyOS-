/**
 * Memory Palace — Rerank（cross-encoder 二次排序）
 *
 * 通用 /rerank 协议，兼容 SiliconFlow / Jina / Cohere / Voyage：
 *   POST {baseUrl}/rerank
 *   {
 *     "model": "BAAI/bge-reranker-v2-m3",
 *     "query": "...",
 *     "documents": ["text1", "text2", ...],
 *     "top_n": 5,
 *     "return_documents": false
 *   }
 *   → { "results": [{ "index": 3, "relevance_score": 0.95 }, ...] }
 *
 * 用途：主召回给 LLM 的是"embedding 找的最像 + 启发式加权"的 top 15，
 *      rerank 用 cross-encoder 直接理解 (query, doc) 对的语义相关性，
 *      把 LLM 回合里用户真正在问的焦点记忆额外推上来几条。
 *
 * 主召回和 rerank 的候选池不共享：pipeline 用 joined userIntent 单独
 * 再跑一次 hybridSearch 作为 rerank 输入池（这一轮 user 发言对应的语义空间）。
 */

import { safeFetchJson, extractContent } from '../safeApi';
import { isOpenCodeGoEndpoint, buildApiRequestHeaders, getOpenCodeSessionId } from '../apiConfigNormalize';

export interface RerankApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export interface RerankResult {
    /** 对应输入 documents[] 的下标 */
    index: number;
    /** 模型给出的相关性分数，通常 0-1，但不同模型 scale 不同，只用于排序 */
    relevance_score: number;
}

/**
 * 调用 rerank API，返回 top N 的 (index, score) 列表。
 *
 * 失败会 throw，让调用方决定是否 warn 或降级。一般失败原因：
 *   - API key 无效 / 余额不足
 *   - baseUrl 写错或网络不通（和 embedding 共用服务商时往往一起挂）
 *   - 模型名错（SiliconFlow 大小写敏感，"BAAI/bge-reranker-v2-m3"）
 */
export async function rerankDocuments(
    config: RerankApiConfig,
    query: string,
    documents: string[],
    topN: number,
): Promise<RerankResult[]> {
    if (documents.length === 0 || !query.trim()) return [];

    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    if (isOpenCodeGoEndpoint(baseUrl)) {
        // Go exposes chat completion, not a native cross-encoder /rerank route.
        // Use the configured Go chat model as a bounded LLM reranker instead.
        const data = await safeFetchJson(
            `${baseUrl}/chat/completions`,
            {
                method: 'POST',
                headers: buildApiRequestHeaders(config.apiKey, undefined, {
                    baseUrl,
                    sessionId: getOpenCodeSessionId('memory-rerank'),
                }),
                body: JSON.stringify({
                    model: config.model,
                    messages: [
                        {
                            role: 'system',
                            content: '你是记忆检索重排器。根据用户问题评估每条记忆的相关性。只返回 JSON 对象：{"results":[{"index":0,"relevance_score":0.0}]}。index 必须是输入文档原始下标，relevance_score 为 0 到 1 的数字。按相关性从高到低排序，不得编造或改写记忆。',
                        },
                        {
                            role: 'user',
                            content: JSON.stringify({
                                query,
                                top_n: Math.min(topN, documents.length),
                                documents: documents.map((text, index) => ({ index, text: text.slice(0, 3500) })),
                            }),
                        },
                    ],
                    temperature: 0,
                    max_tokens: Math.min(6000, Math.max(500, documents.length * 100)),
                    stream: false,
                }),
            },
            1,
            30_000,
            { appName: '记忆宫殿', purpose: 'OpenCode Go 记忆重排' },
        );
        const raw = extractContent(data).trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '');
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('OpenCode Go 记忆重排没有返回有效 JSON');
        let parsed: any;
        try { parsed = JSON.parse(raw.slice(start, end + 1)); }
        catch { throw new Error('OpenCode Go 记忆重排返回的 JSON 无法解析'); }
        const rows: any[] = Array.isArray(parsed?.results) ? parsed.results : [];
        return rows
            .filter(row => Number.isInteger(row?.index) && row.index >= 0 && row.index < documents.length)
            .map(row => ({
                index: row.index,
                relevance_score: Math.max(0, Math.min(1, Number(row.relevance_score ?? row.score ?? 0))),
            }))
            .filter(row => Number.isFinite(row.relevance_score))
            .sort((a, b) => b.relevance_score - a.relevance_score)
            .slice(0, Math.min(topN, documents.length));
    }
    const url = `${baseUrl}/rerank`;
    const body = {
        model: config.model,
        query,
        documents,
        top_n: Math.min(topN, documents.length),
        return_documents: false,
    };

    const data = await safeFetchJson(
        url,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
        },
        1,
        30_000,
    );

    const rows: any[] = Array.isArray(data?.results) ? data.results
                     : Array.isArray(data?.data)    ? data.data
                     : [];

    return rows
        .filter(r => typeof r?.index === 'number')
        .map(r => ({
            index: r.index,
            relevance_score: typeof r.relevance_score === 'number' ? r.relevance_score
                          : typeof r.score === 'number'            ? r.score
                          : 0,
        }));
}
