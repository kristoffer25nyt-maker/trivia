import React, { useState, useEffect } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import { motion, AnimatePresence } from 'motion/react';
import {
  Brain,
  Sparkles,
  Trophy,
  ChevronRight,
  Loader2,
  AlertCircle,
  Gamepad2,
  RefreshCcw,
  Bot,
  Clock
} from 'lucide-react';
import { cn } from './lib/utils';
import { auth, db } from './firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User, signOut } from 'firebase/auth';
import { collection, doc, setDoc, getDocs, query, orderBy, limit, serverTimestamp, where } from 'firebase/firestore';
import { handleFirestoreError, OperationType } from './lib/firestoreUtils';
import { Leaderboard } from './components/Leaderboard';

type GameState = 'SETUP' | 'LOADING' | 'PLAYING' | 'FEEDBACK' | 'GAMEOVER';

interface CustomPersonality {
  id: string;
  name: string;
  prompt: string;
}

interface QuestionData {
  hostCommentary: string;
  question: string;
  options: string[];
  correctOptionIndex: number;
  funFact: string;
}

const QuestionSchema = {
  type: Type.OBJECT,
  properties: {
    hostCommentary: {
      type: Type.STRING,
      description: "Host's verbal reaction to the previous round (if any) and introduction to the next question, staying entirely in character without breaking the fourth wall.",
    },
    question: {
      type: Type.STRING,
      description: "The trivia question text.",
    },
    options: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Exactly 4 multiple choice options.",
    },
    correctOptionIndex: {
      type: Type.INTEGER,
      description: "Index of the correct option (0-3).",
    },
    funFact: {
      type: Type.STRING,
      description: "A fun fact about the correct answer to display after they guess.",
    },
  },
  required: ["hostCommentary", "question", "options", "correctOptionIndex", "funFact"],
};

const PRESET_PERSONALITIES = [
  "Den smukkeste pige",
  "En billig escort",
  "En klog skolelærer med seksuelle lyster",
];

const PRESET_TOPICS = [
  "Popkultur & Film",
  "Porno Skuespillere",
  "Bizarre Mordmysterier",
  "Fræk Slang & Udtryk",
  "Sjove Konspirationsteorier",
  "Mærkelig Historie",
];

export default function App() {
  const [gameState, setGameState] = useState<GameState | 'LEADERBOARD'>('SETUP');
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, u => setUser(u));
    return () => unsubscribe();
  }, []);

  const loginWithGoogle = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error(err);
    }
  };

  const handleSignOut = () => {
    signOut(auth);
  };

  
  // Game Setup
  const [personality, setPersonality] = useState(PRESET_PERSONALITIES[0]);
  const [customPersonalities, setCustomPersonalities] = useState<CustomPersonality[]>(() => {
    const saved = localStorage.getItem('customPersonalities');
    return saved ? JSON.parse(saved) : [];
  });
  const [showCustomHostForm, setShowCustomHostForm] = useState(false);
  const [customHostData, setCustomHostData] = useState({ name: '', traits: '', speech: '', backstory: '' });
  const [topic, setTopic] = useState(PRESET_TOPICS[0]);
  const [difficulty, setDifficulty] = useState('Mellem');
  const [totalQuestions, setTotalQuestions] = useState(5);
  const [timerDuration, setTimerDuration] = useState(60);

  useEffect(() => {
    localStorage.setItem('customPersonalities', JSON.stringify(customPersonalities));
  }, [customPersonalities]);

  const handleSaveCustomHost = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customHostData.name.trim()) return;

    const prompt = `Navn: ${customHostData.name}. Træk: ${customHostData.traits}. Talemåde: ${customHostData.speech}. Baggrundshistorie: ${customHostData.backstory}.`;
    
    const newHost = {
      id: Date.now().toString(),
      name: customHostData.name,
      prompt: prompt
    };
    setCustomPersonalities(prev => [...prev, newHost]);
    setPersonality(prompt);
    setShowCustomHostForm(false);
    setCustomHostData({ name: '', traits: '', speech: '', backstory: '' });
  };
  
  // Active Game State
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(1);
  const [score, setScore] = useState(0);
  const [questionData, setQuestionData] = useState<QuestionData | null>(null);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [pastQuestions, setPastQuestions] = useState<string[]>([]);
  const [gameOverMessage, setGameOverMessage] = useState('');
  const [error, setError] = useState<{title: string, message: string, type: string} | null>(null);
  const [timeLeft, setTimeLeft] = useState(60);

  useEffect(() => {
    if (gameState === 'PLAYING') {
      if (timeLeft > 0) {
        const timerId = setTimeout(() => setTimeLeft(t => t - 1), 1000);
        return () => clearTimeout(timerId);
      } else {
        handleOptionSelect(-1);
      }
    }
  }, [gameState, timeLeft]);

  const getErrorDetails = (err: any) => {
    const errMsg = err?.message || String(err);
    
    if (!navigator.onLine || errMsg.toLowerCase().includes('fetch') || errMsg.toLowerCase().includes('network')) {
      return {
        title: "Forbindelsesfejl",
        message: "Der er problemer med din internetforbindelse. Tjek venligst din forbindelse og prøv igen.",
        type: 'network'
      };
    }
    
    if (errMsg.includes('API_KEY is not defined') || errMsg.includes('API key')) {
      return {
        title: "Manglende API Nøgle",
        message: "Din API nøgle mangler eller er ugyldig. Sørg for at den er konfigureret korrekt.",
        type: 'api'
      };
    }
    
    if (errMsg.toLowerCase().includes('quota') || errMsg.includes('429')) {
      return {
        title: "API-grænse Nået",
        message: "Vi har nået grænsen for AI genereringer lige nu. Vent venligst et øjeblik før du prøver igen.",
        type: 'api'
      };
    }
    
    if (errMsg.toLowerCase().includes('overloaded') || errMsg.includes('503')) {
      return {
        title: "AI'en Er Overbelastet",
        message: "Vores AI host tænker lidt for meget lige nu. Prøv igen om et øjeblik.",
        type: 'api'
      };
    }
    
    if (errMsg.includes('parse') || errMsg.includes('JSON')) {
      return {
        title: "AI Forvirring",
        message: "AI'en gav et svar der ikke kunne forstås. Prøv venligst igen.",
        type: 'api'
      };
    }
    
    return {
      title: "Noget Gik Galt",
      message: errMsg || "Der opstod en uventet fejl. Prøv venligst igen.",
      type: 'unknown'
    };
  };

  const [activeAudioContext, setActiveAudioContext] = useState<AudioContext | null>(null);
  const [activeAudioSource, setActiveAudioSource] = useState<AudioBufferSourceNode | null>(null);

  const stopAudio = () => {
    if (activeAudioSource) {
      try {
        activeAudioSource.stop();
        activeAudioSource.disconnect();
      } catch (e) {
        console.error(e);
      }
      setActiveAudioSource(null);
    }
  };

  const playAudioForText = async (text: string, currentPersonality: string) => {
    stopAudio();
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return;
      
      const ai = new GoogleGenAI({ apiKey });

      let voiceName = 'Kore';
      if (currentPersonality.toLowerCase().includes('skolelærer') || currentPersonality.toLowerCase().includes('pige') || currentPersonality.toLowerCase().includes('escort')) {
        voiceName = 'Kore';
      } else if (currentPersonality.toLowerCase().includes('troldmand') || currentPersonality.toLowerCase().includes('gangster')) {
        voiceName = 'Charon'; 
      } else if (currentPersonality.toLowerCase().includes('fitness')) {
        voiceName = 'Zephyr';
      }

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const binary = atob(base64Audio);
        const buffer = new ArrayBuffer(binary.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binary.length; i++) {
            view[i] = binary.charCodeAt(i);
        }
        
        // 16-bit PCM little-endian
        const float32Data = new Float32Array(buffer.byteLength / 2);
        const dataView = new DataView(buffer);
        for (let i = 0; i < float32Data.length; i++) {
            const int16 = dataView.getInt16(i * 2, true);
            float32Data[i] = int16 / 32768.0;
        }
        
        const audioContext = activeAudioContext || new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        if (!activeAudioContext) setActiveAudioContext(audioContext);
        
        const audioBuffer = audioContext.createBuffer(1, float32Data.length, 24000);
        audioBuffer.getChannelData(0).set(float32Data);
        
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        setActiveAudioSource(source);
        source.start();
      }
    } catch (err: any) {
      if (err?.error?.code === 429 || err?.status === 'RESOURCE_EXHAUSTED') {
        console.warn("TTS quota exhausted, skipping audio.");
      } else {
        console.error("TTS generation failed:", err);
      }
    }
  };

  const fetchNextQuestion = async (isFirst: boolean, prevOutcomeText?: string) => {
    setGameState('LOADING');
    setError(null);
    setTimeLeft(timerDuration);
    
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not defined.");
      }
      
      const ai = new GoogleGenAI({ apiKey });
      
      let context = pastQuestions.length > 0 
        ? `Tidligere stillede spørgsmål (gentag IKKE disse):\n` + pastQuestions.map((q, i) => `${i+1}. ${q}`).join('\n') + `\n\n`
        : "";

      let prompt = context;
      if (isFirst) {
        prompt += `Start spillet! Introducer dig selv i din karakter og stil Spørgsmål 1. (Alt skal være på dansk)`;
      } else {
        prompt += `Brugeren svarede på Spørgsmål ${currentQuestionIndex - 1}. ${prevOutcomeText}. 
        Giv en reaktion der passer til din karakter, og stil derefter Spørgsmål ${currentQuestionIndex}. (Alt skal være på dansk)`;
      }

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          systemInstruction: `You are the host of a trivia game.
Topic: ${topic}
Difficulty: ${difficulty}
Total Questions: ${totalQuestions}
Your Personality: ${personality}
CRITICAL: You MUST remain entirely in character for "hostCommentary". Svar UDELUKKENDE på dansk. Do not break the illusion. Generate questions appropriate for the "${difficulty}" difficulty level in Danish.`,
          responseMimeType: "application/json",
          responseSchema: QuestionSchema,
          temperature: 0.8,
        }
      });

      const jsonStr = response.text?.trim() || "";
      let cleanJson = jsonStr;
      if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      
      const data: QuestionData = JSON.parse(cleanJson);
      
      setPastQuestions(prev => [...prev, data.question]);
      setQuestionData(data);
      setSelectedOption(null);
      setGameState('PLAYING');
      
      // Play audio for host commentary and question
      playAudioForText(`${data.hostCommentary} ... ${data.question}`, personality);
      
    } catch (err: any) {
      console.error(err);
      setError(getErrorDetails(err));
      // If we fail on a later question, fall back to FEEDBACK to let them retry
      if (!isFirst && questionData) {
        setGameState('FEEDBACK');
      } else {
        setGameState('SETUP');
      }
    }
  };

  const startGame = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!topic.trim()) {
      setError({ title: "Manglende Emne", message: "Vælg venligst et emne for at starte spillet.", type: "validation" });
      return;
    }

    if (topic.trim().length > 100) {
      setError({ title: "Emnet er for langt", message: "Gør emnet lidt kortere (maks 100 tegn).", type: "validation" });
      return;
    }

    if (topic.trim().length <= 2) {
      setError({ title: "Emnet er for kort", message: "Angiv venligst et mere specifikt emne.", type: "validation" });
      return;
    }

    const broadTopics = ["alt", "ting", "noget", "hvad som helst", "verden", "videnskab", "historie", "fakta", "spørgsmål", "gæt", "alt muligt", "andet"];
    if (broadTopics.includes(topic.trim().toLowerCase())) {
      setError({ 
        title: "Emnet er for bredt", 
        message: "Dette emne er for bredt til at lave gode spørgsmål. Prøv at være lidt mere specifik (f.eks. 'Europæisk Historie i 1900-tallet' i stedet for bare 'Historie').", 
        type: "validation" 
      });
      return;
    }

    setCurrentQuestionIndex(1);
    setScore(0);
    setPastQuestions([]);
    fetchNextQuestion(true);
  };

  const handleOptionSelect = (index: number) => {
    if (gameState !== 'PLAYING') return;
    
    stopAudio();

    if (index === -1) {
      setSelectedOption(-1);
    } else {
      setSelectedOption(index);
      const isCorrect = index === questionData?.correctOptionIndex;
      if (isCorrect) {
        setScore(s => s + 1);
      }
    }
    setGameState('FEEDBACK');
    if (questionData && questionData.funFact) {
        playAudioForText(questionData.funFact, personality);
    }
  };

  const handleNextRound = () => {
    if (!questionData) return;
    
    const isCorrect = selectedOption === questionData.correctOptionIndex;
    let chosenText = selectedOption !== null ? questionData.options[selectedOption] : "Ingenting";
    const outcomeText = `De valgte "${chosenText}", hvilket var ${isCorrect ? 'RIGTIGT' : 'FORKERT'}.`;
    
    if (currentQuestionIndex < totalQuestions) {
      setCurrentQuestionIndex(i => i + 1);
      fetchNextQuestion(false, outcomeText);
    } else {
      let finalScore = score + (isCorrect ? 1 : 0);
      finishGame(outcomeText, finalScore);
    }
  };

  const saveScoreToLeaderboard = async (finalScore: number) => {
    if (!user) return;
    try {
      const scoreId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
      await setDoc(doc(db, 'leaderboard', scoreId), {
        userId: user.uid,
        displayName: user.displayName || 'Anonymous',
        topic,
        score: finalScore,
        totalQuestions,
        difficulty,
        timestamp: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'leaderboard');
    }
  };

  const finishGame = async (finalOutcome: string, finalScore: number) => {
    setGameState('LOADING');
    try {
      await saveScoreToLeaderboard(finalScore);

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `Brugeren har besvaret det sidste spørgsmål (${currentQuestionIndex}). ${finalOutcome}.
      
Spillet er nu slut. Brugeren scorede ${finalScore} ud af ${totalQuestions}. Giv din afsluttende kommentar i karakter. Svar i ren tekst, INGEN JSON. (Alt skal være på dansk)`;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          systemInstruction: `You are the host of a trivia game. Your Personality: ${personality}. Svar UDELUKKENDE på dansk.`,
          temperature: 0.8,
        }
      });

      const message = response.text || "Tak fordi du spillede med! Det var det hele!";
      setGameOverMessage(message);
      setGameState('GAMEOVER');
      playAudioForText(message, personality);
    } catch (err) {
      console.error(err);
      const errMessage = `Tak fordi du spillede med! Du scorede ${finalScore}/${totalQuestions}.`;
      setGameOverMessage(errMessage);
      setGameState('GAMEOVER');
      playAudioForText(errMessage, personality);
    }
  };

  const resetGame = () => {
    setGameState('SETUP');
  };

  const isCorrectAnswer = selectedOption !== null && selectedOption === questionData?.correctOptionIndex;
  const showAnswers = gameState === 'FEEDBACK';

  let orbGradient = "from-blue-600 via-purple-600 to-indigo-400";
  let orbShadow = ["0px 0px 40px rgba(37,99,235,0.3)", "0px 0px 80px rgba(147,51,234,0.5)", "0px 0px 40px rgba(37,99,235,0.3)"];
  let ringColor1 = "border-blue-500/10";
  let ringColor2 = "border-purple-500/10";
  let badgeColor = "bg-indigo-600";
  let waveColor = "bg-blue-400";

  if (showAnswers) {
    if (isCorrectAnswer) {
      orbGradient = "from-emerald-600 via-teal-600 to-emerald-400";
      orbShadow = ["0px 0px 40px rgba(16,185,129,0.3)", "0px 0px 80px rgba(20,184,166,0.5)", "0px 0px 40px rgba(16,185,129,0.3)"];
      ringColor1 = "border-emerald-500/30";
      ringColor2 = "border-teal-500/30";
      badgeColor = "bg-emerald-600";
      waveColor = "bg-emerald-400";
    } else {
      orbGradient = "from-red-600 via-rose-600 to-red-400";
      orbShadow = ["0px 0px 40px rgba(220,38,38,0.3)", "0px 0px 80px rgba(225,29,72,0.5)", "0px 0px 40px rgba(220,38,38,0.3)"];
      ringColor1 = "border-red-500/30";
      ringColor2 = "border-rose-500/30";
      badgeColor = "bg-red-600";
      waveColor = "bg-red-400";
    }
  }

  return (
    <div className="min-h-screen bg-[#050510] text-slate-100 flex flex-col relative overflow-hidden font-sans">
      {/* Background Ambient Glow */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-900/20 blur-[120px] rounded-full pointer-events-none z-0"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-900/20 blur-[120px] rounded-full pointer-events-none z-0"></div>
      
      <div className="flex-1 overflow-y-auto z-10 w-full max-w-4xl mx-auto p-4 md:p-8 flex flex-col relative">
        <div className="absolute top-4 right-4 z-50 flex gap-4">
          {!user ? (
            <button
              onClick={loginWithGoogle}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-bold shadow-[0_0_15px_rgba(37,99,235,0.3)] transition-all"
            >
              Log ind
            </button>
          ) : (
            <button
              onClick={handleSignOut}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm font-bold border border-white/10 transition-all"
            >
              Log ud
            </button>
          )}
          <button
            onClick={() => setGameState(gameState === 'LEADERBOARD' ? 'SETUP' : 'LEADERBOARD')}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-sm font-bold shadow-[0_0_15px_rgba(147,51,234,0.3)] transition-all"
          >
            {gameState === 'LEADERBOARD' ? 'Tilbage' : 'Leaderboard'}
          </button>
        </div>

        <header className="mb-12 flex flex-col items-center justify-center text-center relative z-10 pt-4">
          <div className="inline-flex items-center justify-center p-3 bg-white/5 rounded-full mb-4 border border-white/10 shadow-[0_0_40px_rgba(37,99,235,0.2)]">
            <Sparkles className="w-8 h-8 text-blue-400 font-bold" />
          </div>
          <h1 className="text-4xl md:text-5xl font-display font-light tracking-tight mb-2 text-white drop-shadow-sm">
            PersonaTrivia
          </h1>
          <p className="text-slate-400 font-medium max-w-lg mt-2">
            Triviaspillet med attitude. Du vælger værtens personlighed, AI tjekker resten.
          </p>
        </header>

        <main className="flex-1 w-full max-w-2xl mx-auto relative z-10">
        <AnimatePresence mode="wait">
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mb-8 p-5 rounded-2xl bg-red-950/40 border border-red-500/20 flex items-start gap-4 shadow-xl backdrop-blur-md"
            >
              <div className={cn("p-2 rounded-full shrink-0", error.type === 'network' ? 'bg-orange-500/20' : 'bg-red-500/20')}>
                <AlertCircle className={cn("w-6 h-6", error.type === 'network' ? 'text-orange-400' : 'text-red-400')} />
              </div>
              <div>
                <h3 className={cn("font-bold mb-1 text-lg", error.type === 'network' ? 'text-orange-300' : 'text-red-300')}>{error.title}</h3>
                <p className={cn("text-sm leading-relaxed", error.type === 'network' ? 'text-orange-200/80' : 'text-red-200/80')}>{error.message}</p>
              </div>
            </motion.div>
          )}

          {gameState === 'LEADERBOARD' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
            >
              <Leaderboard />
            </motion.div>
          )}

          {gameState === 'SETUP' && (
            <motion.form
              key="setup"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              onSubmit={startGame}
              className="bg-white/5 border border-white/10 rounded-2xl p-6 md:p-8 backdrop-blur-md shadow-2xl space-y-8"
            >
              <div className="space-y-4">
                <label className="block">
                  <span className="text-sm font-semibold uppercase tracking-wider text-blue-400 mb-2 block">
                    1. Vælg værtens personlighed
                  </span>
                  <input
                    type="text"
                    value={personality}
                    onChange={(e) => setPersonality(e.target.value)}
                    className="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all font-medium"
                    placeholder="f.eks. Den smukkeste pige"
                    required
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  {PRESET_PERSONALITIES.map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => { setShowCustomHostForm(false); setPersonality(p); }}
                      className="text-xs font-medium px-3 py-1.5 rounded-full bg-white/5 hover:bg-blue-500/20 border border-white/10 hover:border-blue-500/50 transition-colors"
                    >
                      {p}
                    </button>
                  ))}
                  {customPersonalities.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => { setShowCustomHostForm(false); setPersonality(p.prompt); }}
                      className="text-xs font-medium px-3 py-1.5 rounded-full bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/30 hover:border-purple-500/60 transition-colors text-purple-200"
                    >
                      {p.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setShowCustomHostForm(!showCustomHostForm)}
                    className="text-xs font-bold px-3 py-1.5 rounded-full bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 hover:border-emerald-500/60 transition-colors text-emerald-300"
                  >
                    + Lav din egen vært
                  </button>
                </div>
                
                {/* INLINE FORM FOR CUSTOM HOST */}
                <AnimatePresence>
                  {showCustomHostForm && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="bg-slate-900/60 rounded-xl p-5 border border-emerald-500/20 mt-4 space-y-4">
                        <h4 className="font-bold text-emerald-400">Design en ny Vært</h4>
                        <input
                          type="text"
                          placeholder="Navn (f.eks. 'Kongelig Ridder')"
                          value={customHostData.name}
                          onChange={e => setCustomHostData({...customHostData, name: e.target.value})}
                          className="w-full bg-slate-950/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500/50"
                        />
                        <input
                          type="text"
                          placeholder="Personlighedstræk (f.eks. stolt, glad, sarkastisk)"
                          value={customHostData.traits}
                          onChange={e => setCustomHostData({...customHostData, traits: e.target.value})}
                          className="w-full bg-slate-950/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500/50"
                        />
                        <input
                          type="text"
                          placeholder="Talemåde (f.eks. taler oldnordisk, bruger meget slang)"
                          value={customHostData.speech}
                          onChange={e => setCustomHostData({...customHostData, speech: e.target.value})}
                          className="w-full bg-slate-950/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500/50"
                        />
                        <textarea
                          placeholder="Baggrundshistorie (valgfrit)"
                          value={customHostData.backstory}
                          onChange={e => setCustomHostData({...customHostData, backstory: e.target.value})}
                          className="w-full bg-slate-950/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500/50 min-h-[80px]"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={handleSaveCustomHost}
                            disabled={!customHostData.name.trim()}
                            className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-bold px-4 py-2 rounded-lg transition-colors"
                          >
                            Gem & Vælg Vært
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowCustomHostForm(false)}
                            className="bg-white/10 hover:bg-white/20 text-white text-sm px-4 py-2 rounded-lg transition-colors"
                          >
                            Annuller
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="space-y-4">
                <label className="block">
                  <span className="text-sm font-semibold uppercase tracking-wider text-blue-400 mb-2 block">
                    2. Vælg et trivia emne
                  </span>
                  <input
                    type="text"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    className="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all font-medium"
                    placeholder="f.eks. 90'er Actionfilm"
                    required
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  {PRESET_TOPICS.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTopic(t)}
                      className="text-xs font-medium px-3 py-1.5 rounded-full bg-white/5 hover:bg-blue-500/20 border border-white/10 hover:border-blue-500/50 transition-colors"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <label className="block">
                  <span className="text-sm font-semibold uppercase tracking-wider text-blue-400 mb-2 block">
                    3. Vælg sværhedsgrad
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {['Let', 'Mellem', 'Svær'].map(d => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDifficulty(d)}
                      className={cn(
                        "text-sm font-medium px-6 py-2.5 rounded-xl border transition-all",
                        difficulty === d 
                          ? "bg-blue-600 border-blue-400 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]"
                          : "bg-white/5 border-white/10 text-slate-300 hover:bg-blue-500/20 hover:border-blue-500/50"
                      )}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <label className="block">
                  <span className="text-sm font-semibold uppercase tracking-wider text-blue-400 mb-2 block">
                    4. Tid pr. spørgsmål (sekunder)
                  </span>
                  <input
                    type="number"
                    min="5"
                    max="300"
                    value={timerDuration}
                    onChange={(e) => setTimerDuration(parseInt(e.target.value) || 60)}
                    className="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all font-medium"
                    required
                  />
                </label>
              </div>

              <div className="pt-4">
                <button
                  type="submit"
                  className="w-full group relative overflow-hidden rounded-xl bg-blue-600 px-8 py-4 text-white font-bold transition-all hover:bg-blue-500 shadow-[0_0_20px_rgba(37,99,235,0.3)] hover:shadow-[0_0_40px_rgba(37,99,235,0.5)] border border-blue-400/20"
                >
                  <div className="relative z-10 flex items-center justify-center gap-2">
                    <Gamepad2 className="w-5 h-5" />
                    <span>Start Spil</span>
                  </div>
                </button>
              </div>
            </motion.form>
          )}

          {gameState === 'LOADING' && (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-20 text-center"
            >
              <div className="relative mb-12">
                <div className="absolute inset-[-40px] border border-blue-500/10 rounded-full rotate-45 animate-[spin_10s_linear_infinite]" />
                <div className="absolute inset-[-20px] border border-purple-500/10 rounded-full -rotate-12 animate-[spin_7s_linear_infinite_reverse]" />
                <div className="w-32 h-32 rounded-full bg-gradient-to-tr from-blue-600 via-purple-600 to-indigo-400 shadow-[0_0_80px_rgba(37,99,235,0.4)] flex items-center justify-center border-4 border-white/20">
                  <div className="w-28 h-28 rounded-full bg-slate-900 flex flex-col items-center justify-center overflow-hidden">
                    <Loader2 className="w-8 h-8 text-blue-400 animate-spin relative z-10 mb-2" />
                    <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-blue-300">Fremkalder...</p>
                  </div>
                </div>
              </div>
              <h2 className="text-2xl font-light text-white drop-shadow-sm mb-2">Forbinder til AI Værten...</h2>
              <p className="text-indigo-300 font-mono text-sm uppercase tracking-widest opacity-70">
                Genererer karakterdialog & trivia
              </p>
            </motion.div>
          )}

          {(gameState === 'PLAYING' || gameState === 'FEEDBACK') && questionData && (
            <motion.div
              key="playing"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              {/* Top HUD Bar */}
              <nav className="flex justify-between items-center mb-8 px-2 font-sans w-full max-w-2xl mx-auto">
                <div className="flex items-center gap-4">
                  <div className="bg-white/5 border border-white/10 px-4 py-2 rounded-lg backdrop-blur-md">
                    <p className="text-[10px] uppercase tracking-widest text-blue-400 font-bold mb-1">Point</p>
                    <p className="text-2xl font-mono leading-none tracking-tight italic">{score} <span className="text-xs text-white/40 not-italic uppercase">pts</span></p>
                  </div>
                </div>

                <div className="text-right flex gap-4">
                  <div className="bg-white/5 border border-white/10 px-4 py-2 rounded-lg backdrop-blur-md inline-block text-left">
                    <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-1">Emne</p>
                    <p className="text-sm font-medium text-slate-200">{topic}</p>
                  </div>
                  <div className="bg-white/5 border border-white/10 px-4 py-2 rounded-lg backdrop-blur-md inline-block text-left hidden sm:block">
                    <p className="text-[10px] uppercase tracking-widest text-purple-400 font-bold mb-1">Sværhedsgrad</p>
                    <p className="text-sm font-medium text-slate-200">{difficulty}</p>
                  </div>
                </div>
              </nav>

              {/* Main AI Host Arena */}
              <div className="flex flex-col md:flex-row items-center justify-center gap-6 md:gap-8 mb-8 max-w-3xl mx-auto px-4">
                {/* AI Host Mascot/Avatar */}
                <div className="relative mt-4 shrink-0">
                  <motion.div 
                    animate={{ rotate: 360 }}
                    transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                    className={cn("absolute inset-[-30px] border rounded-full transition-colors duration-1000", ringColor1)} 
                  />
                  <motion.div 
                    animate={{ rotate: -360 }}
                    transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
                    className={cn("absolute inset-[-15px] border rounded-full transition-colors duration-1000", ringColor2)} 
                  />
                  <motion.div 
                    animate={{ 
                      boxShadow: orbShadow,
                      scale: showAnswers ? [1, 1.05, 1] : [1, 1.02, 1]
                    }}
                    transition={{ 
                      duration: showAnswers ? 1 : 4, 
                      repeat: Infinity, 
                      ease: "easeInOut" 
                    }}
                    className={cn("w-28 h-28 md:w-32 md:h-32 rounded-full flex items-center justify-center border-4 border-white/20 transition-all duration-1000 bg-gradient-to-tr", orbGradient)}
                  >
                    <div className="w-full h-full rounded-full bg-slate-900 flex flex-col items-center justify-center overflow-hidden z-10 relative">
                       <motion.div
                         animate={{ y: showAnswers ? [0, -5, 0] : [0, -2, 0] }}
                         transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                       >
                         <Bot className={cn("w-12 h-12 md:w-16 md:h-16 transition-colors duration-500", showAnswers ? (isCorrectAnswer ? "text-emerald-400" : "text-red-400") : "text-blue-400")} />
                       </motion.div>
                    </div>
                  </motion.div>
                  <div className={cn("absolute -bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full border border-white/30 shadow-lg text-center min-w-max transition-colors duration-1000 z-20", badgeColor)}>
                    <p className="text-[10px] font-bold uppercase tracking-widest whitespace-nowrap italic text-white">{personality}</p>
                  </div>
                </div>

                {/* AI Host Commentary Bubble */}
                <motion.div 
                  initial={{ opacity: 0, x: -20, scale: 0.95 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  key={questionData.hostCommentary}
                  className="bg-slate-900/80 border border-white/10 p-5 md:p-6 rounded-2xl rounded-tl-none md:rounded-l-none md:rounded-tr-2xl relative shadow-xl backdrop-blur-md flex-1 text-left"
                >
                  {/* Decorative speech pointer */}
                  <div className="absolute -top-[1px] left-8 md:top-6 md:-left-[1px] w-4 h-4 bg-slate-900/80 border border-white/10 border-b-0 border-r-0 transform md:-translate-x-1/2 -rotate-45 hidden sm:block" />
                  
                  <div className="flex items-center gap-3 mb-2 relative z-10">
                    {/* Small Waveform */}
                    <div className="flex items-end justify-center gap-[2px] h-4 opacity-70">
                      {[1, 2, 3, 4].map((i) => (
                        <motion.div
                          key={i}
                          animate={{ height: showAnswers ? ["20%", "80%", "20%"] : ["20%", "100%", "30%"] }}
                          transition={{
                            duration: showAnswers ? 1.5 : 0.8,
                            repeat: Infinity,
                            repeatType: "reverse",
                            ease: "easeInOut",
                            delay: i * 0.1,
                          }}
                          className={cn("w-[2px] rounded-full", waveColor)}
                        />
                      ))}
                    </div>
                    <span className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">Vært</span>
                  </div>
                  <p className="text-sm md:text-base font-display text-slate-200 italic leading-relaxed relative z-10">
                    "{questionData.hostCommentary}"
                  </p>
                </motion.div>
              </div>

                {/* Question Card */}
                <div className="text-center max-w-2xl px-4 mx-auto mb-8">
                  <div className="flex justify-between items-center mb-4">
                    <p className="text-indigo-300 font-mono text-xs uppercase tracking-widest opacity-70">
                      Spørgsmål {currentQuestionIndex} ud af {totalQuestions}
                    </p>
                    <div className={cn("font-mono text-xl font-bold flex items-center gap-2", timeLeft <= 5 ? "text-red-400 animate-pulse" : "text-emerald-400")}>
                      <Clock className="w-5 h-5" />
                      <span>{Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, '0')}</span>
                    </div>
                  </div>
                  <h1 className="text-2xl md:text-3xl font-light leading-tight tracking-tight text-white drop-shadow-sm mb-2">
                     "{questionData.question}"
                  </h1>
                </div>

              {/* Answers Grid */}
              {gameState === 'FEEDBACK' && selectedOption === -1 && (
                <div className="text-red-400 font-bold mb-4 text-center text-lg animate-pulse">
                  Tiden løb ud!
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {questionData.options.map((option, idx) => {
                  const isSelected = selectedOption === idx;
                  const isCorrectOption = idx === questionData.correctOptionIndex;
                  const showAnswers = gameState === 'FEEDBACK';
                  
                  let wrapperClasses = "bg-white/5 border-white/10 group-hover:bg-blue-500/20 group-hover:border-blue-400/50";
                  let badgeClasses = "bg-white/10 text-white group-hover:bg-blue-500 transition-colors";
                  
                  if (showAnswers) {
                    if (isCorrectOption) {
                      wrapperClasses = "bg-emerald-500/20 border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.2)] ring-2 ring-emerald-500/40";
                      badgeClasses = "bg-emerald-500 text-white";
                    } else if (isSelected) {
                      wrapperClasses = "bg-red-500/20 border-red-500/50";
                      badgeClasses = "bg-red-500 text-white";
                    } else {
                      wrapperClasses = "bg-white/5 border-white/10 opacity-50";
                      badgeClasses = "bg-white/10 text-white/50";
                    }
                  } else if (isSelected) {
                    wrapperClasses = "bg-blue-500/20 border-blue-400/50 ring-2 ring-blue-500/40";
                    badgeClasses = "bg-blue-500 text-white";
                  }

                  const letters = ['A', 'B', 'C', 'D'];

                  return (
                    <button
                      key={idx}
                      disabled={showAnswers}
                      onClick={() => handleOptionSelect(idx)}
                      className={cn(
                        "group relative cursor-pointer text-left focus:outline-none w-full",
                        "disabled:cursor-default"
                      )}
                    >
                      <div className={cn("absolute inset-0 border rounded-2xl transition-all duration-300", wrapperClasses)}></div>
                      <div className="relative flex items-center p-5">
                        <span className={cn("w-10 h-10 shrink-0 rounded-lg flex items-center justify-center font-mono font-bold mr-4 transition-colors", badgeClasses)}>
                          {letters[idx]}
                        </span>
                        <p className="text-lg font-medium text-slate-100">{option}</p>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Feedback Context */}
              <AnimatePresence>
                {gameState === 'FEEDBACK' && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="overflow-hidden"
                  >
                    <div className="bg-slate-900/80 rounded-2xl p-6 border border-white/10 mt-6 backdrop-blur-md relative overflow-hidden">
                      <div className="absolute top-0 right-0 p-4 opacity-5">
                        <Trophy className="w-24 h-24 text-white" />
                      </div>
                      <h3 className="text-blue-400 font-bold uppercase tracking-widest text-xs mb-2 relative z-10">Sjov Fakta</h3>
                      <p className="text-slate-300 mb-6 relative z-10 leading-relaxed font-light">{questionData.funFact}</p>
                      
                      <button
                        onClick={handleNextRound}
                        className="w-full md:w-auto md:ml-auto flex items-center justify-center gap-2 bg-blue-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-blue-500 transition-colors shadow-[0_0_20px_rgba(37,99,235,0.3)] relative z-10 border border-blue-400/20"
                      >
                        {currentQuestionIndex < totalQuestions ? "Næste Spørgsmål" : "Afslut Spil"}
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {gameState === 'GAMEOVER' && (
            <motion.div
              key="gameover"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-white/5 rounded-3xl p-8 md:p-12 shadow-2xl border border-white/10 backdrop-blur-md text-center space-y-8 flex flex-col items-center"
            >
              <div className="relative">
                <div className="absolute inset-[-20px] border border-blue-500/20 rounded-full rotate-45 animate-pulse"></div>
                <div className="w-24 h-24 rounded-full bg-gradient-to-tr from-blue-600 to-purple-600 shadow-[0_0_60px_rgba(37,99,235,0.4)] flex items-center justify-center border-2 border-white/20">
                  <Trophy className="w-10 h-10 text-white shadow-lg" />
                </div>
              </div>
              
              <div>
                <h2 className="text-5xl font-mono font-bold mb-2 italic drop-shadow-sm text-slate-100">
                  {score} <span className="text-3xl text-slate-400 not-italic">/ {totalQuestions}</span>
                </h2>
                <div className="text-blue-400 font-bold uppercase tracking-widest text-xs">Endelig Score</div>
              </div>

              <div className="bg-slate-900/50 rounded-2xl p-6 border border-white/10 max-w-md w-full">
                <p className="font-light text-lg text-slate-300 italic">
                  "{gameOverMessage}"
                </p>
              </div>

              <button
                onClick={resetGame}
                className="inline-flex items-center justify-center gap-2 bg-blue-600 px-8 py-4 rounded-xl font-bold text-white hover:bg-blue-500 transition-all w-full md:w-auto shadow-[0_0_20px_rgba(37,99,235,0.3)] border border-blue-400/20"
              >
                <RefreshCcw className="w-5 h-5" />
                Spil Igen
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      
      {/* End of Main Content wrapper */}
      </div>
    </div>
  );
}
