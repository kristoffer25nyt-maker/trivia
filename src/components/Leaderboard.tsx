import React, { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { Trophy, Clock, Brain, Loader2 } from 'lucide-react';

interface ScoreEntry {
  id: string;
  userId: string;
  displayName: string;
  topic: string;
  score: number;
  totalQuestions: number;
  difficulty: string;
}

export function Leaderboard() {
  const [scores, setScores] = useState<ScoreEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchScores = async () => {
      try {
        const q = query(collection(db, 'leaderboard'), orderBy('score', 'desc'), limit(50));
        const snapshot = await getDocs(q);
        const data = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as ScoreEntry[];
        setScores(data);
      } catch (err) {
        console.error("Error fetching leaderboard", err);
      } finally {
        setLoading(false);
      }
    };
    fetchScores();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 md:p-8 backdrop-blur-md shadow-2xl space-y-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-gradient-to-tr from-blue-600 to-purple-600 rounded-lg">
          <Trophy className="w-6 h-6 text-white" />
        </div>
        <h2 className="text-2xl font-bold font-display">Global Leaderboard</h2>
      </div>

      {scores.length === 0 ? (
        <p className="text-slate-400 text-center py-8">Ingen scores endnu. Spil et spil for at komme på tavlen!</p>
      ) : (
        <div className="space-y-3">
          {scores.map((s, idx) => (
            <div key={s.id} className="flex items-center justify-between p-4 bg-slate-900/50 rounded-xl border border-white/5 hover:border-white/10 transition-colors">
              <div className="flex items-center gap-4">
                <span className="text-xl font-mono font-bold text-slate-500 w-8">{idx + 1}.</span>
                <div>
                  <p className="font-bold text-slate-200">{s.displayName}</p>
                  <p className="text-xs text-slate-400 flex items-center gap-2">
                    <span className="text-purple-400">{s.topic}</span>
                    <span>•</span>
                    <span>{s.difficulty}</span>
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-mono text-xl font-bold text-emerald-400">{s.score}</p>
                <p className="text-[10px] uppercase text-slate-500 font-bold tracking-widest">Score / {s.totalQuestions}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
