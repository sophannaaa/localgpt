import { useRef, useState, useEffect, useContext, useLayoutEffect } from 'react'
import { CommandBarButton, DialogType, Stack } from '@fluentui/react'
import { SquareRegular, ErrorCircleRegular } from '@fluentui/react-icons'

import uuid from 'react-uuid'
import { isEmpty } from 'lodash-es'

import styles from './Chat.module.css'
import MR_LOGO from '@assets/MRLogo.png'

import {
  ChatMessage,
  ConversationRequest,
  Citation,
  ToolMessageContent,
  ChatResponse,
  historyGenerate,
  historyUpdate,
  ChatHistoryLoadingState,
  CosmosDBStatus,
  ErrorMessage,
  User
} from '@api/index'
import { Answer } from '@components/Answer'
import { AnswerLoading } from '@components/Answer/AnswerLoading'
import { QuestionInput } from '@components/QuestionInput'
import { AppStateContext } from '@state/AppProvider'
import { useBoolean } from '@fluentui/react-hooks'
import { Disclaimer } from '@components/common/Disclaimer'
import { FAQGrid } from '@components/FAQ/FAQGrid'
import { Header } from '@components/common/Header'
import { UserChatMessage } from '@components/UserChatMessage'
import { AnswerFeedback } from '@components/AnswerFeedback'
import { PolicyNotice } from '@components/PolicyNotice'

const enum messageStatus {
  NotRunning = 'Not Running',
  Processing = 'Processing',
  Done = 'Done'
}

const userGreeting = 'Hi'

const Chat = () => {
  const appStateContext = useContext(AppStateContext)
  const chatMessageStreamEnd = useRef<HTMLDivElement | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [showLoadingMessage, setShowLoadingMessage] = useState<boolean>(false)
  const abortFuncs = useRef([] as AbortController[])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [processMessages, setProcessMessages] = useState<messageStatus>(messageStatus.NotRunning)
  const [hideErrorDialog, { toggle: toggleErrorDialog }] = useBoolean(true)
  const [showDisclaimer, setShowDisclaimer] = useState<boolean>(true)
  const [chatTitle, setChatTitle] = useState<string>('Hi!')
  const [showPolicyNotice, setShowPolicyNotice] = useState<boolean>(true)
  const [policyAgreementStatus, setPolicyAgreementStatus] = useState<boolean>(false)
  const [user, setUser] = useState<User | null>(appStateContext!.state.user)



  const [USER, ASSISTANT, TOOL, ERROR] = ['user', 'assistant', 'tool', 'error']



  const handleDisclaimerClose = () => {
    setShowDisclaimer(false)
  }

  let assistantMessage = {} as ChatMessage
  let toolMessage = {} as ChatMessage
  let assistantContent = ''

  const processResultMessage = (resultMessage: ChatMessage, userMessage: ChatMessage, conversationId?: string) => {
    if (resultMessage.role === ASSISTANT) {
      assistantContent += resultMessage.content
      assistantMessage = resultMessage
      assistantMessage.content = assistantContent

      if (resultMessage.context) {
        toolMessage = {
          id: uuid(),
          role: TOOL,
          content: resultMessage.context,
          date: new Date().toISOString()
        }
      }
    }

    if (resultMessage.role === TOOL) toolMessage = resultMessage

    if (!conversationId) {
      isEmpty(toolMessage)
        ? setMessages([...messages, userMessage, assistantMessage])
        : setMessages([...messages, userMessage, toolMessage, assistantMessage])
    } else {
      isEmpty(toolMessage)
        ? setMessages([...messages, assistantMessage])
        : setMessages([...messages, toolMessage, assistantMessage])
    }
  }

  const makeApiRequestWithCosmosDB = async (question: string, conversationId?: string) => {
    handleDisclaimerClose()
    setIsLoading(true)
    setShowLoadingMessage(true)
    const abortController = new AbortController()
    abortFuncs.current.unshift(abortController)

    const userMessage: ChatMessage = {
      id: uuid(),
      role: 'user',
      content: question,
      date: new Date().toISOString()
    }

    if (user && user.fullname.toLowerCase() != 'dummy' && user.email.toLowerCase() != 'dummy') {
      userMessage.user_name = user.fullname
      userMessage.user_email = user.email
    }

    //api call params set here (generate)
    let request: ConversationRequest
    let conversation
    if (conversationId) {
      conversation = appStateContext?.state?.chatHistory?.find(conv => conv.id === conversationId)
      if (!conversation) {
        console.error('Conversation not found.')
        setIsLoading(false)
        setShowLoadingMessage(false)
        abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
        return
      } else {
        conversation.messages.push(userMessage)
        request = {
          messages: [...conversation.messages.filter(answer => answer.role !== ERROR)]
        }
      }
    } else {
      request = {
        messages: [userMessage].filter(answer => answer.role !== ERROR)
      }
      setMessages(request.messages)
    }
    let result = {} as ChatResponse
    try {
      const response = conversationId
        ? await historyGenerate(request, abortController.signal, conversationId)
        : await historyGenerate(request, abortController.signal)
      if (!response?.ok) {
        const responseJson = await response.json()
        var errorResponseMessage =
          responseJson.error === undefined
            ? 'Please try again. If the problem persists, please contact the site administrator.'
            : responseJson.error
        let errorChatMsg: ChatMessage = {
          id: uuid(),
          role: ERROR,
          content: `There was an error generating a response. Chat history can't be saved at this time.\n ${errorResponseMessage}`,
          date: new Date().toISOString()
        }
        let resultConversation
        if (conversationId) {
          resultConversation = appStateContext?.state?.chatHistory?.find(conv => conv.id === conversationId)
          if (!resultConversation) {
            console.error('Conversation not found.')
            setIsLoading(false)
            setShowLoadingMessage(false)
            abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
            return
          }
          resultConversation.messages.push(errorChatMsg)
        } else {
          setMessages([...messages, userMessage, errorChatMsg])
          setIsLoading(false)
          setShowLoadingMessage(false)
          abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
          return
        }
        appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: resultConversation })
        setMessages([...resultConversation.messages])
        return
      }
      if (response?.body) {
        const reader = response.body.getReader()

        let runningText = ''
        while (true) {
          setProcessMessages(messageStatus.Processing)
          const { done, value } = await reader.read()
          if (done) break

          var text = new TextDecoder('utf-8').decode(value)
          const objects = text.split('\n')
          objects.forEach(obj => {
            try {
              if (obj !== '' && obj !== '{}') {
                runningText += obj
                result = JSON.parse(runningText)
                if (result.choices?.length > 0) {
                  result.choices[0].messages.forEach(msg => {
                    msg.id = result.id
                    msg.date = new Date().toISOString()
                  })
                  if (result.choices[0].messages?.some(m => m.role === ASSISTANT)) {
                    setShowLoadingMessage(false)
                  }
                  result.choices[0].messages.forEach(resultObj => {
                    processResultMessage(resultObj, userMessage, conversationId)
                  })
                }
                runningText = ''
              } else if (result.error) {
                throw Error(result.error)
              }
            } catch (e) {
              if (!(e instanceof SyntaxError)) {
                console.error(e)
                throw e
              } else {
                console.log('Incomplete message. Continuing...')
              }
            }
          })
        }

        let resultConversation
        if (conversationId) {
          resultConversation = appStateContext?.state?.chatHistory?.find(conv => conv.id === conversationId)
          if (!resultConversation) {
            console.error('Conversation not found.')
            setIsLoading(false)
            setShowLoadingMessage(false)
            abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
            return
          }
          isEmpty(toolMessage)
            ? resultConversation.messages.push(assistantMessage)
            : resultConversation.messages.push(toolMessage, assistantMessage)
        } else {
          resultConversation = {
            id: result.history_metadata.conversation_id,
            title: result.history_metadata.title,
            messages: [userMessage],
            date: result.history_metadata.date
          }
          isEmpty(toolMessage)
            ? resultConversation.messages.push(assistantMessage)
            : resultConversation.messages.push(toolMessage, assistantMessage)
        }
        if (!resultConversation) {
          setIsLoading(false)
          setShowLoadingMessage(false)
          abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
          return
        }
        appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: resultConversation })
        isEmpty(toolMessage)
          ? setMessages([...messages, assistantMessage])
          : setMessages([...messages, toolMessage, assistantMessage])
      }
    } catch (e) {
      if (!abortController.signal.aborted) {
        let errorMessage = `An error occurred. ${errorResponseMessage}`
        if (result.error?.message) {
          errorMessage = result.error.message
        } else if (typeof result.error === 'string') {
          errorMessage = result.error
        }
        let errorChatMsg: ChatMessage = {
          id: uuid(),
          role: ERROR,
          content: errorMessage,
          date: new Date().toISOString()
        }
        let resultConversation
        if (conversationId) {
          resultConversation = appStateContext?.state?.chatHistory?.find(conv => conv.id === conversationId)
          if (!resultConversation) {
            console.error('Conversation not found.')
            setIsLoading(false)
            setShowLoadingMessage(false)
            abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
            return
          }
          resultConversation.messages.push(errorChatMsg)
        } else {
          if (!result.history_metadata) {
            console.error('Error retrieving data.', result)
            console.log('errorMessage', errorMessage)
            let errorChatMsg: ChatMessage = {
              id: uuid(),
              role: ERROR,
              content: errorMessage,
              date: new Date().toISOString()
            }
            setMessages([...messages, userMessage, errorChatMsg])
            setIsLoading(false)
            setShowLoadingMessage(false)
            abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
            return
          }
          resultConversation = {
            id: result.history_metadata.conversation_id,
            title: result.history_metadata.title,
            messages: [userMessage],
            date: result.history_metadata.date
          }
          resultConversation.messages.push(errorChatMsg)
        }
        if (!resultConversation) {
          setIsLoading(false)
          setShowLoadingMessage(false)
          abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
          return
        }
        appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: resultConversation })
        setMessages([...messages, errorChatMsg])
      } else {
        setMessages([...messages, userMessage])
      }
    } finally {
      setIsLoading(false)
      setShowLoadingMessage(false)
      abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
      setProcessMessages(messageStatus.Done)
    }
    return abortController.abort()
  }

  const newChat = () => {
    setShowDisclaimer(true)
    setProcessMessages(messageStatus.Processing)
    setMessages([])
    appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: null })
    setProcessMessages(messageStatus.Done)
  }

  const stopGenerating = () => {
    abortFuncs.current.forEach(a => a.abort())
    setShowLoadingMessage(false)
    setIsLoading(false)
  }

  useEffect(() => {
    if (appStateContext?.state.currentChat) {
      setMessages(appStateContext.state.currentChat.messages)
    } else {
      setMessages([])
    }
  }, [appStateContext?.state.currentChat])

  useLayoutEffect(() => {
    const saveToDB = async (messages: ChatMessage[], id: string) => {
      const response = await historyUpdate(messages, id)
      return response
    }

    if (appStateContext && appStateContext.state.currentChat && processMessages === messageStatus.Done) {
      if (appStateContext.state.isCosmosDBAvailable.cosmosDB) {
        if (!appStateContext?.state.currentChat?.messages) {
          console.error('Failure fetching current chat state.')
          return
        }
        saveToDB(appStateContext.state.currentChat.messages, appStateContext.state.currentChat.id)
          .then(res => {
            if (!res.ok) {
              let errorMessage =
                "An error occurred. Answers can't be saved at this time. If the problem persists, please contact the site administrator."
              let errorChatMsg: ChatMessage = {
                id: uuid(),
                role: ERROR,
                content: errorMessage,
                date: new Date().toISOString()
              }
              if (!appStateContext?.state.currentChat?.messages) {
                let err: Error = {
                  ...new Error(),
                  message: 'Failure fetching current chat state.'
                }
                throw err
              }
              setMessages([...appStateContext?.state.currentChat?.messages, errorChatMsg])
            }
            return res as Response
          })
          .catch(err => {
            console.error('Error: ', err)
            let errRes: Response = {
              ...new Response(),
              ok: false,
              status: 500
            }
            return errRes
          })
      } else {
      }
      appStateContext?.dispatch({ type: 'UPDATE_CHAT_HISTORY', payload: appStateContext.state.currentChat })
      setMessages(appStateContext.state.currentChat.messages)
      setProcessMessages(messageStatus.NotRunning)
    }
  }, [processMessages])

  useEffect(() => {
    setUser(appStateContext!.state.user)
    setChatTitle(userGreeting + ', ' + user?.firstname + '!') // Hi, First_Name!
  }, [appStateContext?.state.user])

  useLayoutEffect(() => {
    chatMessageStreamEnd.current?.scrollIntoView({ behavior: 'smooth' })
  }, [showLoadingMessage, processMessages])


  const onViewSource = (citation: Citation) => {
    if (citation.url && !citation.url.includes('blob.core')) {
      window.open(citation.url, '_blank')
    }
  }

  const handleViewPolicyNotice = () => {
    setShowPolicyNotice(true)
  }

  const handlePolicyAgreementStatus = () => {
    setPolicyAgreementStatus(true)
    setShowPolicyNotice(false)
  }

  const handlePolicyNoticeDismiss = () => {
    setShowPolicyNotice(false)
  }

  const parseCitationFromMessage = (message: ChatMessage) => {
    if (message?.role && message?.role === 'tool') {
      try {
        const toolMessage = JSON.parse(message.content) as ToolMessageContent
        return toolMessage.citations
      } catch {
        return []
      }
    }
    return []
  }

  const disabledButton = () => {
    return isLoading || (messages && messages.length === 0)
  }

  return (
    <div className={styles.container} role="main">
      <Header
        onClick={newChat}
        titleClickDisabled={disabledButton()}
        onViewPolicyClick={handleViewPolicyNotice}
      />
      <PolicyNotice
        hidden={showPolicyNotice}
        onDismiss={handlePolicyNoticeDismiss}
        onAgree={handlePolicyAgreementStatus}
      />
      <Stack horizontal className={styles.chatRoot}>
        <div className={styles.chatContainer}>
          {!messages || messages.length < 1 ? (
            <>
              <Stack className={styles.chatEmptyState}>
                <img src={MR_LOGO} className={styles.chatIcon} aria-hidden="true" />
                <h1 className={styles.chatEmptyStateTitle}>{chatTitle}</h1>
                <h2 className={styles.chatEmptyStateSubtitle}>
                  I'm here to answer your questions regarding Security and Compliance
                </h2>
              </Stack>
              <FAQGrid
                onSend={makeApiRequestWithCosmosDB}
                conversationId={
                  appStateContext?.state.currentChat?.id ? appStateContext?.state.currentChat?.id : undefined
                }
              />
            </>
          ) : (
            <div className={styles.chatMessageStream} style={{ marginBottom: isLoading ? '40px' : '0px' }} role="log">
              {messages.map((answer, index) => (
                <>
                  {answer.role === USER ? (
                    <UserChatMessage message={answer.content} />
                  ) : answer.role === ASSISTANT ? (
                    <div className={styles.chatMessageGpt}>
                      <Answer
                        answer={{
                          answer: answer.content,
                          citations: parseCitationFromMessage(messages[index - 1]),
                          message_id: answer.id,
                          feedback: answer.feedback
                        }}
                      />
                    </div>
                  ) : answer.role === ERROR ? (
                    <div className={styles.chatMessageError}>
                      <Stack horizontal className={styles.chatMessageErrorContent}>
                        <ErrorCircleRegular className={styles.errorIcon} style={{ color: 'rgba(182, 52, 67, 1)' }} />
                        <span>Error</span>
                      </Stack>
                      <span className={styles.chatMessageErrorContent}>{answer.content}</span>
                    </div>
                  ) : null}
                </>
              ))}
              {showLoadingMessage && (
                <>
                  <div className={styles.chatMessageGpt}>
                    <AnswerLoading />
                  </div>
                </>
              )}
              <div ref={chatMessageStreamEnd} />
            </div>
          )}
          <Stack className={styles.disclaimerContainerRoot}>
            {showDisclaimer && (
              <Disclaimer
                className={styles.disclaimerContainer}
                onDismiss={handleDisclaimerClose}
                text={
                  'This Copilot currently provides information on  Program Security and Compliance. This is currently a preview - AI generated responses may be inaccurate.'
                }
              />
            )}
          </Stack>

          <Stack horizontal className={styles.chatInput}>
            {isLoading && (
              <Stack
                horizontal
                className={styles.stopGeneratingContainer}
                role="button"
                aria-label="Stop generating"
                tabIndex={0}
                onClick={stopGenerating}
                onKeyDown={e => (e.key === 'Enter' || e.key === ' ' ? stopGenerating() : null)}>
                <SquareRegular className={styles.stopGeneratingIcon} aria-hidden="true" />
                <span className={styles.stopGeneratingText} aria-hidden="true">
                  Stop generating
                </span>
              </Stack>
            )}
            <Stack>
              <CommandBarButton
                role="button"
                styles={{
                  icon: {
                    color: '#FFFFFF'
                  },
                  iconDisabled: {
                    color: '#BDBDBD !important'
                  },
                  root: {
                    color: '#FFFFFF',
                    background:
                      'radial-gradient(circle at 50% 50%, rgba(245, 166, 200, 1) 0%, rgba(171, 78, 157, 1) 46%, rgba(116, 88, 166, 1) 100%);'
                  },
                  rootDisabled: {
                    background: '#F0F0F0'
                  }
                }}
                className={styles.newChatIcon}
                iconProps={{ iconName: 'Add' }}
                onClick={newChat}
                disabled={disabledButton()}
                aria-label="start a new chat button"
              />
            </Stack>
            <QuestionInput
              clearOnSend
              placeholder="Type a new question..."
              disabled={isLoading || !policyAgreementStatus}
              onSend={(question, id) => {
                makeApiRequestWithCosmosDB(question, id)
              }}
              conversationId={
                appStateContext?.state.currentChat?.id ? appStateContext?.state.currentChat?.id : undefined
              }
              policyAgreementStatus={policyAgreementStatus}
            />
          </Stack>
        </div>
        <AnswerFeedback />
      </Stack>
    </div>
  )
}

export default Chat
