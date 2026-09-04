import type {
  ConversationDetail,
  ConversationListItem,
  ConversationMessage,
  ConversationMessageInput,
  CreateConversationInput,
} from "../../shared/conversation-types";
import type { VideoTranscript } from "../../shared/media-types";
import {
  ConversationRepository,
  parseAppendMessagesInput,
  parseConversationId,
  parseCreateConversationInput,
  parseRenameConversationInput,
  parseTruncateMessagesInput,
  parseUpdateTranscriptInput,
} from "../database/conversation-repository";

export class ConversationService {
  constructor(private readonly repository: ConversationRepository) {}

  list(): Promise<ConversationListItem[]> {
    return this.repository.list();
  }

  create(value: unknown): Promise<ConversationDetail> {
    return this.repository.create(parseCreateConversationInput(value));
  }

  get(conversationId: string): Promise<ConversationDetail> {
    return this.repository.get(parseConversationId(conversationId));
  }

  rename(conversationId: string, value: unknown): Promise<ConversationListItem> {
    const { title } = parseRenameConversationInput(value);
    return this.repository.rename(
      parseConversationId(conversationId),
      title,
    );
  }

  updateTranscript(
    conversationId: string,
    value: unknown,
  ): Promise<VideoTranscript> {
    const { transcript } = parseUpdateTranscriptInput(value);
    return this.repository.updateTranscript(
      parseConversationId(conversationId),
      transcript,
    );
  }

  delete(conversationId: string): Promise<void> {
    return this.repository.delete(parseConversationId(conversationId));
  }

  appendMessages(
    conversationId: string,
    value: unknown,
  ): Promise<ConversationMessage[]> {
    return this.repository.appendMessages(
      parseConversationId(conversationId),
      parseAppendMessagesInput(value),
    );
  }

  truncateMessages(conversationId: string, value: unknown): Promise<void> {
    return this.repository.truncateMessages(
      parseConversationId(conversationId),
      parseTruncateMessagesInput(value),
    );
  }

  createTyped(input: CreateConversationInput): Promise<ConversationDetail> {
    return this.create(input);
  }

  appendMessagesTyped(
    conversationId: string,
    messages: ConversationMessageInput[],
  ): Promise<ConversationMessage[]> {
    return this.appendMessages(conversationId, { messages });
  }
}
