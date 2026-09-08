import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationListItem } from "@/shared/conversation-types";
import {
  deleteConversation,
  listConversations,
  renameConversation,
} from "../clients/conversation-client";

interface ConversationHistoryOptions {
  activeConversationId: string | null;
  onRestoreConversation: (id: string) => void;
  onActiveConversationDeleted: () => void;
}

export function useConversationHistory({
  activeConversationId,
  onRestoreConversation,
  onActiveConversationDeleted,
}: ConversationHistoryOptions) {
  const [items, setItems] = useState<ConversationListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const didRestoreRef = useRef(false);
  const restoreRef = useRef(onRestoreConversation);
  const deletedRef = useRef(onActiveConversationDeleted);
  restoreRef.current = onRestoreConversation;
  deletedRef.current = onActiveConversationDeleted;

  const upsert = useCallback((item: ConversationListItem) => {
    setItems((current) =>
      [item, ...current.filter((conversation) => conversation.id !== item.id)].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    );
  }, []);

  const touch = useCallback((id: string) => {
    setItems((current) =>
      current
        .map((item) =>
          item.id === id ? { ...item, updatedAt: Date.now() } : item,
        )
        .sort((left, right) => right.updatedAt - left.updatedAt),
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void listConversations(controller.signal)
      .then((loadedItems) => {
        setItems(loadedItems);
        setError(null);
        if (!didRestoreRef.current && loadedItems[0]) {
          didRestoreRef.current = true;
          restoreRef.current(loadedItems[0].id);
        }
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "无法读取对话列表。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  const beginRename = useCallback((item: ConversationListItem) => {
    setRenamingId(item.id);
    setRenameDraft(item.title);
    setError(null);
  }, []);

  const saveRename = useCallback(async (id: string) => {
    const title = renameDraft.trim();
    if (!title) {
      setError("对话名称不能为空。");
      return;
    }
    setBusyId(id);
    try {
      const renamed = await renameConversation(id, title);
      upsert(renamed);
      setRenamingId(null);
      setRenameDraft("");
      setError(null);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "重命名失败，请稍后重试。");
    } finally {
      setBusyId(null);
    }
  }, [renameDraft, upsert]);

  const deleteItem = useCallback(async (item: ConversationListItem) => {
    if (!globalThis.confirm(`删除对话“${item.title}”？此操作不可撤销。`)) return;
    setBusyId(item.id);
    setError(null);
    try {
      await deleteConversation(item.id);
      setItems((current) =>
        current.filter((conversation) => conversation.id !== item.id),
      );
      if (activeConversationId === item.id) deletedRef.current();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除失败，请稍后重试。");
    } finally {
      setBusyId(null);
    }
  }, [activeConversationId]);

  return {
    items,
    isLoading,
    error,
    setError,
    loadingId,
    setLoadingId,
    busyId,
    renamingId,
    setRenamingId,
    renameDraft,
    setRenameDraft,
    isOpen,
    setIsOpen,
    menuRef,
    buttonRef,
    upsert,
    touch,
    beginRename,
    saveRename,
    deleteItem,
  };
}
