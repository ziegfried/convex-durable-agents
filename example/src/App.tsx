import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";
import { ThreadSidebar } from "./ThreadSidebar";
import { Chat } from "./Chat";
import { NewChatScreen } from "./NewChatScreen";
import { WelcomeScreen } from "./WelcomeScreen";

function App() {
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [isNewChat, setIsNewChat] = useState(false);
  const threads = useQuery(api.chat.listThreads, { limit: 50 });
  const deleteThread = useMutation(api.chat.deleteThread);

  const handleNewThread = () => {
    // Don't create thread yet, just show the new chat screen
    setCurrentThreadId(null);
    setIsNewChat(true);
  };

  const handleThreadCreated = (threadId: string) => {
    setCurrentThreadId(threadId);
    setIsNewChat(false);
  };

  const handleSelectThread = (threadId: string) => {
    setCurrentThreadId(threadId);
    setIsNewChat(false);
  };

  const handleDeleteThread = async (threadId: string) => {
    try {
      await deleteThread({ threadId });
      if (currentThreadId === threadId) {
        setCurrentThreadId(null);
      }
    } catch (error) {
      console.error("Failed to delete thread:", error);
    }
  };

  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw" }}>
      <ThreadSidebar
        threads={threads}
        currentThreadId={currentThreadId}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
        onDeleteThread={handleDeleteThread}
      />
      {currentThreadId ? (
        <Chat threadId={currentThreadId} />
      ) : isNewChat ? (
        <NewChatScreen onThreadCreated={handleThreadCreated} />
      ) : (
        <WelcomeScreen onNewThread={handleNewThread} />
      )}
    </div>
  );
}

export default App;
