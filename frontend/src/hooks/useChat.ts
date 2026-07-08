import { useCallback, useEffect, useMemo } from 'react';
import useConversationApi from './useConversationApi';
import { produce } from 'immer';
import {
  MessageContent,
  DisplayMessageContent,
  MessageMap,
  Model,
  PostMessageRequest,
  Conversation,
  PutFeedbackRequest,
  TextContent,
  Content,
} from '../@types/conversation';
import useConversation from './useConversation';
import { create } from 'zustand';
import usePostMessageStreaming from './usePostMessageStreaming';
import { ulid } from 'ulid';
import { convertMessageMapToArray } from '../utils/MessageUtils';
import useModel from './useModel';
import useFeedbackApi from './useFeedbackApi';
import { useMachine } from '@xstate/react';
import { streamingStateMachine } from './xstates/streaming';

type ChatStateType = {
  [id: string]: MessageMap;
};

type BotInputType = {
  botId: string;
  hasKnowledge: boolean;
  hasAgent: boolean;
};

export type AttachmentType = {
  fileName: string;
  fileType: string;
  extractedContent: string;
};

export type ThinkingAction =
  | {
      type: 'doing';
    }
  | { type: 'init' };

const NEW_MESSAGE_ID = {
  USER: 'new-message',
  ASSISTANT: 'new-message-assistant',
};
const USE_STREAMING: boolean =
  import.meta.env.VITE_APP_USE_STREAMING === 'true';

// Debounce interval for streaming renders (ms).
// Tokens are buffered and rendered at this rate to avoid excessive re-renders.
// 50ms ≈ 20 renders/sec — visually smooth, much less CPU work.
const STREAMING_RENDER_INTERVAL = 50;

const getTextContentBody = (content: Content[]): string => {
  const textContent = content.find(
    (c): c is TextContent => c.contentType === 'text'
  );
  return textContent?.body || '';
};

const useChatState = create<{
  conversationId: string;
  setConversationId: (s: string) => void;
  postingMessage: boolean;
  setPostingMessage: (b: boolean) => void;
  chats: ChatStateType;
  setMessages: (id: string, messageMap: MessageMap) => void;
  copyMessages: (fromId: string, toId: string) => void;
  pushMessage: (
    id: string,
    parentMessageId: string | null,
    currentMessageId: string,
    content: MessageContent
  ) => void;
  removeMessage: (id: string, messageId: string) => void;
  editMessage: (id: string, messageId: string, content: string) => void;
  getMessages: (
    id: string,
    currentMessageId: string
  ) => DisplayMessageContent[];
  currentMessageId: string;
  setCurrentMessageId: (s: string) => void;
  isGeneratedTitle: boolean;
  setIsGeneratedTitle: (b: boolean) => void;
  getPostedModel: () => Model;
  shouldUpdateMessages: (currentConversation: Conversation) => boolean;
  shouldCotinue: boolean;
  setShouldContinue: (b: boolean) => void;
  getShouldContinue: () => boolean;
  reasoningEnabled: boolean;
  setReasoningEnabled: (enabled: boolean) => void;
}>((set, get) => {
  return {
    conversationId: '',
    setConversationId: (s) => {
      set(() => {
        return {
          conversationId: s,
        };
      });
    },
    postingMessage: false,
    setPostingMessage: (b) => {
      set(() => ({
        postingMessage: b,
      }));
    },
    chats: {},
    setMessages: (id: string, messageMap: MessageMap) => {
      set((state) => ({
        chats: produce(state.chats, (draft) => {
          draft[id] = messageMap;
        }),
      }));
    },
    copyMessages: (fromId: string, toId: string) => {
      set((state) => ({
        chats: produce(state.chats, (draft) => {
          draft[toId] = JSON.parse(JSON.stringify(draft[fromId]));
        }),
      }));
    },
    pushMessage: (
      id: string,
      parentMessageId: string | null,
      currentMessageId: string,
      content: MessageContent
    ) => {
      set(() => ({
        chats: produce(get().chats, (draft) => {
          if (draft[id] && parentMessageId && parentMessageId !== 'system') {
            draft[id][parentMessageId] = {
              ...draft[id][parentMessageId],
              children: [
                ...draft[id][parentMessageId].children,
                currentMessageId,
              ],
            };
            draft[id][currentMessageId] = {
              ...content,
              parent: parentMessageId,
              children: [],
            };
          } else {
            draft[id] = {
              [currentMessageId]: {
                ...content,
                children: [],
                parent: null,
              },
            };
          }
        }),
      }));
    },
    editMessage: (id: string, messageId: string, content: string) => {
      set(() => ({
        chats: produce(get().chats, (draft) => {
          const textContent = draft[id][messageId].content.find(
            (c) => c.contentType === 'text'
          );
          if (textContent && textContent.body !== content) {
            textContent.body = content;
          }
        }),
      }));
    },
    removeMessage: (id: string, messageId: string) => {
      set((state) => ({
        chats: produce(state.chats, (draft) => {
          const childrenIds = [...draft[id][messageId].children];

          while (childrenIds.length > 0) {
            const targetId = childrenIds.pop()!;
            childrenIds.push(...draft[id][targetId].children);
            delete draft[id][targetId];
          }

          Object.keys(draft[id]).forEach((key) => {
            const idx = draft[id][key].children.findIndex(
              (c) => c === messageId
            );
            if (idx > -1) {
              draft[id][key].children.splice(idx, 1);
            }
          });
          delete draft[id][messageId];
        }),
      }));
    },
    getMessages: (id: string, currentMessageId: string) => {
      return convertMessageMapToArray(get().chats[id] ?? {}, currentMessageId);
    },
    currentMessageId: '',
    setCurrentMessageId: (s: string) => {
      set(() => ({
        currentMessageId: s,
      }));
    },
    isGeneratedTitle: false,
    setIsGeneratedTitle: (b: boolean) => {
      set(() => ({
        isGeneratedTitle: b,
      }));
    },
    getPostedModel: () => {
      return (
        get().chats[get().conversationId]?.system?.model ??
        get().chats['']?.[NEW_MESSAGE_ID.ASSISTANT]?.model
      );
    },
    shouldUpdateMessages: (currentConversation) => {
      return (
        !!get().conversationId &&
        currentConversation.id === get().conversationId &&
        !get().postingMessage &&
        get().currentMessageId !== currentConversation.lastMessageId
      );
    },
    getShouldContinue: () => {
      return get().shouldCotinue;
    },
    setShouldContinue: (b) => {
      set(() => ({
        shouldCotinue: b,
      }));
    },
    shouldCotinue: false,
    reasoningEnabled: false,
    setReasoningEnabled: (enabled) => set({ reasoningEnabled: enabled }),
  };
});

const useChat = () => {
  const [streamingState, streamingSend, streamingActor] = useMachine(streamingStateMachine);

  const {
    chats,
    conversationId,
    setConversationId,
    postingMessage,
    setPostingMessage,
    setMessages,
    pushMessage,
    editMessage,
    copyMessages,
    removeMessage,
    getMessages,
    currentMessageId,
    setCurrentMessageId,
    isGeneratedTitle,
    setIsGeneratedTitle,
    getPostedModel,
    shouldUpdateMessages,
    getShouldContinue,
    setShouldContinue,
    reasoningEnabled,
    setReasoningEnabled,
  } = useChatState();

  const { post: postStreaming } = usePostMessageStreaming();
  const { modelId, setModelId, availableModels } = useModel();

  const conversationApi = useConversationApi();
  const feedbackApi = useFeedbackApi();
  const {
    data,
    mutate,
    isLoading: loadingConversation,
    error: conversationError,
  } = conversationApi.getConversation(conversationId);
  const { syncConversations } = useConversation();

  const {
    data: relatedDocuments,
    mutate: reloadRelatedDocuments,
    isLoading: loadingRelatedDocuments,
    error: relatedDocumentsError,
  } = conversationApi.getRelatedDocuments(conversationId);

  const messages = useMemo(() => {
    return getMessages(conversationId, currentMessageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, chats, currentMessageId]);

  const newChat = useCallback(() => {
    setConversationId('');
    setMessages('', {});
  }, [setConversationId, setMessages]);

  // when updated messages
  useEffect(() => {
    if (data && shouldUpdateMessages(data)) {
      setMessages(conversationId, data.messageMap);
      setCurrentMessageId(data.lastMessageId);
      setModelId(getPostedModel());
      reloadRelatedDocuments();
    }
    if (data && data.shouldContinue !== getShouldContinue()) {
      setShouldContinue(data.shouldContinue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, data]);

  useEffect(() => {
    setIsGeneratedTitle(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const supportReasoning = useMemo(() => {
    // If existing conversation data, use that model
    const postedModel = getPostedModel();
    // Before data is obtained, use the currently selected model
    const effectiveModel = postedModel || modelId;
    // Check if the model supports reasoning
    return availableModels.some(
      (m) => m.modelId === effectiveModel && m.supportReasoning
    );
  }, [modelId, availableModels, getPostedModel]);

  useEffect(() => {
    // If the model does not support reasoning, disable reasoning
    if (!supportReasoning) {
      setReasoningEnabled(false);
    }
  }, [supportReasoning, setReasoningEnabled]);

  const pushNewMessage = (
    parentMessageId: string | null,
    messageContent: MessageContent
  ) => {
    pushMessage(
      conversationId ?? '',
      parentMessageId,
      NEW_MESSAGE_ID.USER,
      messageContent
    );
    pushMessage(
      conversationId ?? '',
      NEW_MESSAGE_ID.USER,
      NEW_MESSAGE_ID.ASSISTANT,
      {
        role: 'assistant',
        content: [
          {
            contentType: 'text',
            body: '',
          },
        ],
        model: messageContent.model,
        feedback: messageContent.feedback,
        usedChunks: messageContent.usedChunks,
        thinkingLog: messageContent.thinkingLog,
      }
    );
  };

  const postChat = (params: {
    content: string;
    enableReasoning: boolean;
    base64EncodedImages?: string[];
    attachments?: AttachmentType[];
    bot?: BotInputType;
  }) => {
    const { content, bot, base64EncodedImages, attachments } = params;
    const isNewChat = conversationId ? false : true;
    const newConversationId = ulid();

    const tmpMessages = convertMessageMapToArray(
      useChatState.getState().chats[conversationId] ?? {},
      currentMessageId
    );

    const parentMessageId = isNewChat
      ? 'system'
      : tmpMessages[tmpMessages.length - 1].id;

    const modelToPost = isNewChat ? modelId : getPostedModel();
    const imageContents: MessageContent['content'] = (
      base64EncodedImages ?? []
    ).map((encodedImage) => {
      const result =
        /data:(?<mediaType>image\/.+);base64,(?<encodedImage>.+)/.exec(
          encodedImage
        );

      return {
        body: result!.groups!.encodedImage,
        contentType: 'image',
        mediaType: result!.groups!.mediaType,
      };
    });

    const attachContents: MessageContent['content'] = (attachments ?? []).map(
      (attachment) => {
        return {
          body: attachment.extractedContent,
          contentType: 'attachment',
          mediaType: attachment.fileType,
          fileName: attachment.fileName,
        };
      }
    );

    const messageContent: MessageContent = {
      content: [
        ...attachContents,
        ...imageContents,
        {
          body: content,
          contentType: 'text',
        },
      ],
      model: modelToPost,
      role: 'user',
      feedback: null,
      usedChunks: null,
      thinkingLog: null,
    };
    const input: PostMessageRequest = {
      conversationId: isNewChat ? newConversationId : conversationId,
      message: {
        ...messageContent,
        parentMessageId: parentMessageId,
      },
      botId: bot?.botId,
      enableReasoning: params.enableReasoning,
    };
    const createNewConversation = () => {
      // Copy State to prevent screen flicker
      copyMessages('', newConversationId);

      conversationApi
        .updateTitleWithGeneratedTitle(newConversationId)
        .then(() => {
          setConversationId(newConversationId);
        })
        .finally(() => {
          syncConversations().then(() => {
            setIsGeneratedTitle(true);
          });
        });
    };

    setPostingMessage(true);

    // Update State for immediate reflection on screen
    pushNewMessage(parentMessageId, messageContent);

    // post message
    const postPromise = new Promise<void>((resolve, reject) => {
      if (USE_STREAMING) {
        // Debounced subscription: buffer tokens and render at STREAMING_RENDER_INTERVAL
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const subscription = streamingActor.subscribe(state => {
          if (flushTimer) return;
          flushTimer = setTimeout(() => {
            flushTimer = null;
            editMessage(conversationId, NEW_MESSAGE_ID.ASSISTANT, state.context.text);
          }, STREAMING_RENDER_INTERVAL);
        });
        postStreaming({
          input,
          handleStreamingEvent: (event) => {
            streamingSend(event);
          },
        })
          .then(() => {
            // Final flush: ensure last tokens are rendered
            if (flushTimer) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            const finalText = streamingActor.getSnapshot().context.text;
            editMessage(conversationId, NEW_MESSAGE_ID.ASSISTANT, finalText);
            resolve();
          })
          .catch((e) => {
            if (flushTimer) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            reject(e);
          })
          .finally(() => {
            subscription.unsubscribe();
          });
      } else {
        conversationApi
          .postMessage(input)
          .then((res) => {
            const textBody = getTextContentBody(res.data.message.content);
            editMessage(conversationId, NEW_MESSAGE_ID.ASSISTANT, textBody);
            resolve();
          })
          .catch((e) => {
            reject(e);
          });
      }
    });

    postPromise
      .then(() => {
        if (isNewChat) {
          createNewConversation();
        } else {
          mutate();
        }
      })
      .catch((e) => {
        console.error(e);
        removeMessage(conversationId, NEW_MESSAGE_ID.ASSISTANT);
        removeMessage(conversationId, NEW_MESSAGE_ID.USER);
        mutate();
      })
      .finally(() => {
        setPostingMessage(false);
      });
  };

  /**
   * Continue to generate
   */
  const continueGenerate = (params?: {
    messageId?: string;
    bot?: BotInputType;
  }) => {
    setPostingMessage(true);

    const messageContent: MessageContent = {
      content: [],
      model: getPostedModel(),
      role: 'user',
      feedback: null,
      usedChunks: null,
      thinkingLog: null,
    };
    const input: PostMessageRequest = {
      conversationId: conversationId,
      message: {
        ...messageContent,
        parentMessageId: messages[messages.length - 1].id,
      },
      botId: params?.bot?.botId,
      continueGenerate: true,
      enableReasoning: false,
    };

    const lastMessage = messages[messages.length - 1];
    const currentContentBody = getTextContentBody(lastMessage.content);
    const currentMessage = messages[messages.length - 1];

    // Debounced subscription for continue generate
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const subscription = streamingActor.subscribe(state => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        editMessage(conversationId, currentMessage.id, currentContentBody + state.context.text);
      }, STREAMING_RENDER_INTERVAL);
    });
    postStreaming({
      input,
      handleStreamingEvent: (event) => {
        streamingSend(event);
      },
    })
      .then(() => {
        // Final flush
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        const finalText = streamingActor.getSnapshot().context.text;
        editMessage(conversationId, currentMessage.id, currentContentBody + finalText);
        mutate();
      })
      .catch((e) => {
        console.error(e);
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
      })
      .finally(() => {
        subscription.unsubscribe();
        setPostingMessage(false);
      });
  };

  /**
   * Regenerate
   */
  const regenerate = (props?: {
    enableReasoning: boolean;
    content?: string;
    messageId?: string;
    bot?: BotInputType;
  }) => {
    let index: number = -1;
    if (props?.messageId) {
      index = messages.findIndex((m) => m.id === props.messageId);
    }

    const isRetryError = messages[messages.length - 1].role === 'user';
    if (index === -1) {
      index = isRetryError ? messages.length - 1 : messages.length - 2;
    }

    const parentMessage = produce(messages[index], (draft) => {
      if (props?.content) {
        const textIndex = draft.content.findIndex(
          (content) => content.contentType === 'text'
        );
        if (textIndex >= 0) {
          (draft.content[textIndex] as TextContent).body = props.content;
        }
      }
    });

    if (props?.content) {
      editMessage(conversationId, parentMessage.id, props.content);
    }

    const input: PostMessageRequest = {
      conversationId: conversationId,
      message: {
        ...parentMessage,
        parentMessageId: parentMessage.parent,
      },
      botId: props?.bot?.botId,
      enableReasoning: props?.enableReasoning ?? false,
    };

    if (input.message.parentMessageId === null) {
      input.message.parentMessageId = 'system';
    }

    setPostingMessage(true);

    if (isRetryError) {
      pushMessage(
        conversationId ?? '',
        parentMessage.id,
        NEW_MESSAGE_ID.ASSISTANT,
        {
          role: 'assistant',
          content: [
            {
              contentType: 'text',
              body: '',
            },
          ],
          model: messages[index].model,
          feedback: messages[index].feedback,
          usedChunks: messages[index].usedChunks,
          thinkingLog: messages[index].thinkingLog,
        }
      );
    } else {
      pushNewMessage(parentMessage.parent, parentMessage);
    }

    setCurrentMessageId(NEW_MESSAGE_ID.ASSISTANT);

    // Debounced subscription for regenerate
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const subscription = streamingActor.subscribe(state => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        editMessage(conversationId, NEW_MESSAGE_ID.ASSISTANT, state.context.text);
      }, STREAMING_RENDER_INTERVAL);
    });
    postStreaming({
      input,
      handleStreamingEvent: (event) => {
        streamingSend(event);
      },
    })
      .then(() => {
        // Final flush
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        const finalText = streamingActor.getSnapshot().context.text;
        editMessage(conversationId, NEW_MESSAGE_ID.ASSISTANT, finalText);
        mutate();
      })
      .catch((e) => {
        console.error(e);
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        removeMessage(conversationId, NEW_MESSAGE_ID.ASSISTANT);
        mutate();
      })
      .finally(() => {
        subscription.unsubscribe();
        setPostingMessage(false);
      });
  };

  const hasError = useMemo(() => {
    const length_ = messages.length;
    return length_ === 0 ? false : messages[length_ - 1].role === 'user';
  }, [messages]);

  return {
    streamingState,
    hasError,
    setConversationId,
    conversationId,
    loadingConversation,
    conversationError,
    postingMessage: postingMessage || loadingConversation,
    isGeneratedTitle,
    setIsGeneratedTitle,
    newChat,
    messages,
    setCurrentMessageId,
    postChat,
    regenerate,
    getPostedModel,
    getShouldContinue,
    continueGenerate,
    reasoningEnabled,
    setReasoningEnabled,
    supportReasoning,
    retryPostChat: (params: {
      enableReasoning: boolean;
      content?: string;
      bot?: BotInputType;
    }) => {
      const length_ = messages.length;
      if (length_ === 0) {
        return;
      }
      const latestMessage = messages[length_ - 1];
      if (latestMessage.sibling.length === 1) {
        removeMessage(conversationId, latestMessage.id);

        const latestMessageBody = getTextContentBody(latestMessage.content);
        postChat({
          content: params.content ?? latestMessageBody,
          enableReasoning: params.enableReasoning,
          bot: params.bot
            ? {
                botId: params.bot.botId,
                hasKnowledge: params.bot.hasKnowledge,
                hasAgent: params.bot.hasAgent,
              }
            : undefined,
        });
      } else {
        const latestMessageBody = getTextContentBody(latestMessage.content);
        regenerate({
          enableReasoning: params.enableReasoning,
          content: params.content ?? latestMessageBody,
          bot: params.bot,
        });
      }
    },
    relatedDocuments,
    reloadRelatedDocuments,
    loadingRelatedDocuments,
    relatedDocumentsError,
    giveFeedback: (messageId: string, feedback: PutFeedbackRequest) => {
      return feedbackApi
        .putFeedback(conversationId, messageId, feedback)
        .then(() => {
          mutate();
        });
    },
  };
};

export default useChat;
