import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, DownloadSimple, MagnifyingGlassPlus, MagnifyingGlassMinus, ArrowsClockwise, CaretLeft, CaretRight } from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';
import { useBlobRefUrl } from '../../utils/blobRef';
import './ChatImage.css';

export function ImageViewer({ value, fallback, name, onClose, generation, messageId, charId, variants = [], activeVariantIndex = 0, onSelectVariant }: { value: string; fallback: string; name?: string; onClose: () => void; generation?: any; messageId?: number; charId?: string; variants?: string[]; activeVariantIndex?: number; onSelectVariant?: (index: number) => void }) {
    const [failed, setFailed] = useState(false), [zoom, setZoom] = useState(false);
    const touchStartX = useRef<number | null>(null);
    const src = useBlobRefUrl(failed ? fallback : value);
    const close = useRef<HTMLButtonElement>(null);
    useEffect(() => setFailed(false), [value]);
    useEffect(() => { const previous = document.activeElement as HTMLElement; close.current?.focus(); return () => previous?.focus(); }, []);
    return createPortal(<div className="chat-image-viewer" role="dialog" aria-modal="true" aria-label="图片预览"
        onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()} onPointerMove={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()} onTouchEnd={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()} onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Escape') onClose();
            if (e.key === 'Tab') {
                const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button,a[href]'));
                const first = controls[0], last = controls[controls.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        }}>
        <header><button ref={close} onClick={onClose} aria-label="关闭图片预览" title="关闭"><X size={24} /></button><div>
            <button onClick={() => setZoom(v => !v)} aria-label={zoom ? '缩小图片' : '放大图片'} title={zoom ? '缩小' : '放大'}>{zoom ? <MagnifyingGlassMinus size={24} /> : <MagnifyingGlassPlus size={24} />}</button>
            {variants.length > 1 && <span className="text-xs text-white/80 tabular-nums">{activeVariantIndex + 1}/{variants.length}</span>}
            {variants.length > 1 && <button onClick={() => onSelectVariant?.(Math.max(0, activeVariantIndex - 1))} disabled={activeVariantIndex <= 0} aria-label="上一张版本" title="上一张版本"><CaretLeft size={24}/></button>}
            {variants.length > 1 && <button onClick={() => onSelectVariant?.(Math.min(variants.length - 1, activeVariantIndex + 1))} disabled={activeVariantIndex >= variants.length - 1} aria-label="下一张版本" title="下一张版本"><CaretRight size={24}/></button>}
            {generation?.sceneDescription && <button onClick={() => window.dispatchEvent(new CustomEvent('sully:chat-image-reroll', { detail: { charId, messageId, generation } }))} aria-label="重新生成这张图片" title="重新生成这张图片"><ArrowsClockwise size={24} /></button>}{src && <a href={src} download={name || 'photo'} aria-label="保存图片" title="保存图片"><DownloadSimple size={24} /></a>}
        </div></header>
        <div className={`chat-image-stage ${zoom ? 'is-zoomed' : ''}`} onTouchStart={e => { touchStartX.current = e.touches[0]?.clientX ?? null; }} onTouchEnd={e => { if (touchStartX.current === null || variants.length < 2) return; const delta = e.changedTouches[0]?.clientX - touchStartX.current; if (Math.abs(delta) > 45) onSelectVariant?.(delta < 0 ? Math.min(variants.length - 1, activeVariantIndex + 1) : Math.max(0, activeVariantIndex - 1)); touchStartX.current = null; }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            {src ? <img src={src} alt="聊天图片预览" onError={() => setFailed(true)} /> : <span role="status">正在读取图片…</span>}
        </div>
    </div>, document.body);
}

export default function ChatImage({ value, original, name, selectionMode, eager, onLoad, generation, messageId, charId, variants = [], activeVariantIndex = 0 }: { value: string; original?: string; name?: string; selectionMode: boolean; eager?: boolean; onLoad?: () => void; generation?: any; messageId?: number; charId?: string; variants?: string[]; activeVariantIndex?: number }) {
    const [open, setOpen] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(activeVariantIndex);
    useEffect(() => setSelectedIndex(Math.max(0, Math.min(activeVariantIndex, variants.length - 1))), [activeVariantIndex, variants.length]);
    const currentValue = variants[selectedIndex] || value;
    const selectVariant = (index: number) => {
        const next = Math.max(0, Math.min(index, variants.length - 1));
        setSelectedIndex(next);
        window.dispatchEvent(new CustomEvent('sully:chat-image-select-variant', { detail: { charId, messageId, index: next } }));
    };
    return <><button className="chat-image-thumbnail" type="button" aria-label="查看大图" onClick={e => { if (selectionMode) return; e.stopPropagation(); setOpen(true); }}>
        <TokenImg value={currentValue} className="max-w-[200px] max-h-[300px] rounded-2xl" alt="聊天图片" loading={eager ? 'eager' : 'lazy'} decoding="async" onLoad={onLoad} />
    </button>{open && <ImageViewer value={currentValue} fallback={currentValue} name={name} onClose={() => setOpen(false)} generation={generation} messageId={messageId} charId={charId} variants={variants} activeVariantIndex={selectedIndex} onSelectVariant={selectVariant} />}</>;
}
