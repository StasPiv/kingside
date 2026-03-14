import { useState, useCallback, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import type { CustomTimeControl } from '@kingside/shared';

export type TimeControlCategory = 'bullet' | 'blitz' | 'rapid' | 'classical';

export type TimeControlPreset = {
  minutes: number;
  increment: number;
  category: TimeControlCategory;
};

export const TC_LABEL_KEYS: Record<TimeControlCategory, string> = {
  bullet: 'lobby.bullet',
  blitz: 'lobby.blitz',
  rapid: 'lobby.rapid',
  classical: 'lobby.classical',
} as const;

export const PRESETS: TimeControlPreset[] = [
  { minutes: 1, increment: 0, category: 'bullet' },
  { minutes: 1, increment: 1, category: 'bullet' },
  { minutes: 2, increment: 1, category: 'bullet' },
  { minutes: 3, increment: 0, category: 'blitz' },
  { minutes: 3, increment: 2, category: 'blitz' },
  { minutes: 5, increment: 0, category: 'blitz' },
  { minutes: 5, increment: 3, category: 'blitz' },
  { minutes: 10, increment: 0, category: 'rapid' },
  { minutes: 10, increment: 5, category: 'rapid' },
  { minutes: 15, increment: 10, category: 'rapid' },
  { minutes: 30, increment: 0, category: 'classical' },
  { minutes: 30, increment: 20, category: 'classical' },
  { minutes: 60, increment: 0, category: 'classical' },
];

export const CATEGORIES: TimeControlCategory[] = ['bullet', 'blitz', 'rapid', 'classical'];

export function presetKey(minutes: number, increment: number): string {
  return `${minutes}+${increment}`;
}

export function useTimeControl() {
  const { user } = useAuth();
  const [selectedMinutes, setSelectedMinutes] = useState(5);
  const [selectedIncrement, setSelectedIncrement] = useState(0);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customMinutes, setCustomMinutes] = useState(5);
  const [customIncrement, setCustomIncrement] = useState(0);
  const [savedControls, setSavedControls] = useState<CustomTimeControl[]>([]);
  const [activeTab, setActiveTab] = useState<TimeControlCategory | 'custom'>('blitz');

  const loadSavedControls = useCallback(async () => {
    if (!user) return;
    try {
      const data = await api.get<CustomTimeControl[]>('/api/users/me/time-controls');
      setSavedControls(data);
    } catch {
      // silent
    }
  }, [user]);

  useEffect(() => {
    loadSavedControls();
  }, [loadSavedControls]);

  const handleSelectPreset = (minutes: number, increment: number) => {
    setSelectedMinutes(minutes);
    setSelectedIncrement(increment);
  };

  const handleSaveCustom = async () => {
    if (!user) return;
    try {
      await api.post('/api/users/me/time-controls', {
        initialSec: customMinutes * 60,
        incrementSec: customIncrement,
      });
      await loadSavedControls();
      setShowCustomForm(false);
    } catch {
      // silent
    }
  };

  const handleUseCustom = () => {
    setSelectedMinutes(customMinutes);
    setSelectedIncrement(customIncrement);
    setShowCustomForm(false);
  };

  const handleDeleteSaved = async (id: string) => {
    try {
      await api.delete(`/api/users/me/time-controls/${id}`);
      setSavedControls((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // silent
    }
  };

  const handleSelectSaved = (ctrl: CustomTimeControl) => {
    setSelectedMinutes(Math.floor(ctrl.initialSec / 60));
    setSelectedIncrement(ctrl.incrementSec);
  };

  const isSelected = (minutes: number, increment: number) =>
    selectedMinutes === minutes && selectedIncrement === increment;

  const filteredPresets =
    activeTab === 'custom'
      ? []
      : PRESETS.filter((p) => p.category === activeTab);

  return {
    selectedMinutes,
    selectedIncrement,
    showCustomForm,
    setShowCustomForm,
    customMinutes,
    setCustomMinutes,
    customIncrement,
    setCustomIncrement,
    savedControls,
    activeTab,
    setActiveTab,
    loadSavedControls,
    handleSelectPreset,
    handleSaveCustom,
    handleUseCustom,
    handleDeleteSaved,
    handleSelectSaved,
    isSelected,
    filteredPresets,
  };
}
