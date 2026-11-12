import {
  validateTextScript,
  sanitizeTextScript,
  isAllowedChar,
} from './unicode-script-validator';

describe('UnicodeScriptValidator', () => {
  describe('User-Reported Cross-Script Failures', () => {
    it('should detect Gujarati text in Bengali translation (Q121 bug)', () => {
      const gujaratiInBengali = 'પ્રશ્ન ૧૨૧: યુકેરીયોટિક કોષનું પાવરહાઉસ કયા કોષ અંગિકાને કહેવામાં આવે છે?';
      const res = validateTextScript(gujaratiInBengali, 'bn');
      expect(res.isValid).toBe(false);
      expect(res.violations.length).toBeGreaterThan(0);
      expect(res.violations[0].detectedScript).toContain('Gujarati');
    });

    it('should accept genuine Bengali text', () => {
      const cleanBengali = 'ইউক্যারিওটিক কোষের শক্তিকেন্দ্র বা পাওয়ারহাউস কোন কোষ অঙ্গাণুকে বলা হয়?';
      const res = validateTextScript(cleanBengali, 'bn');
      expect(res.isValid).toBe(true);
      expect(res.violations).toHaveLength(0);
    });

    it('should detect Gujarati word સ્થિતિ in Telugu (Q2 bug)', () => {
      const contaminatedTelugu = 'సమతుల్య સ્થિતિ లో ఉన్న వస్తువు';
      const res = validateTextScript(contaminatedTelugu, 'te');
      expect(res.isValid).toBe(false);
      expect(res.violations.some((v) => v.detectedScript?.includes('Gujarati'))).toBe(true);
    });

    it('should accept clean Telugu with Telugu స్థితి', () => {
      const cleanTelugu = 'సమతుల్య స్థితి లో ఉన్న వస్తువు';
      const res = validateTextScript(cleanTelugu, 'te');
      expect(res.isValid).toBe(true);
    });

    it('should detect Tamil suffix த்தின் in Telugu (Q101 bug)', () => {
      const mixedTeluguTamil = 'యూకారియోటిక్ కణத்தின் పవర్‌హౌస్';
      const res = validateTextScript(mixedTeluguTamil, 'te');
      expect(res.isValid).toBe(false);
      expect(res.violations.some((v) => v.detectedScript?.includes('Tamil'))).toBe(true);
    });

    it('should detect Greek etymological text in Kannada (Q165 bug)', () => {
      const greekInKannada = 'ಸ್ಯಾಲ್ಟೇಷನ್ (απότομη εξέλιξη)';
      const res = validateTextScript(greekInKannada, 'kn');
      expect(res.isValid).toBe(false);
      expect(res.violations.some((v) => v.detectedScript?.includes('Greek'))).toBe(true);
    });

    it('should detect Thai characters in Kannada (Q41 bug)', () => {
      const thaiInKannada = 'ಏม่ಕರೂಪಿ ม่';
      const res = validateTextScript(thaiInKannada, 'kn');
      expect(res.isValid).toBe(false);
      expect(res.violations.some((v) => v.detectedScript?.includes('Thai'))).toBe(true);
    });

    it('should detect Devanagari in Gujarati (Q24/Q145 bug)', () => {
      const devanagariInGujarati = 'અભિસારી (अभिसारी)';
      const res = validateTextScript(devanagariInGujarati, 'gu');
      expect(res.isValid).toBe(false);
      expect(res.violations.some((v) => v.detectedScript?.includes('Devanagari'))).toBe(true);
    });

    it('should detect Tamil suffix in Malayalam (Q44 bug)', () => {
      // Tamil letter கி (U+0B95 U+0BBF) or Tamil suffix inside Malayalam
      const tamilInMalayalam = '400 K നും 300 K നும் (அமைவு)';
      const res = validateTextScript(tamilInMalayalam, 'ml');
      expect(res.isValid).toBe(false);
      expect(res.violations.some((v) => v.detectedScript?.includes('Tamil'))).toBe(true);
    });
  });

  describe('Scientific Notation & Formulas Whitelist', () => {
    it('should allow valid chemical formulas, units, numbers and math symbols in regional text', () => {
      const scientificBengali = 'H₂O এবং CO2 এর তাপমাত্রা 400 K ± 2 °C এবং বেগ 10 m/s² (pH = 7.4)';
      const res = validateTextScript(scientificBengali, 'bn');
      expect(res.isValid).toBe(true);
      expect(res.violations).toHaveLength(0);
    });

    it('should allow sub/superscripts, math operators and Latin scientific acronyms in Telugu', () => {
      const scientificTelugu = 'ATP ఉత్పత్తి మరియు DNA సంశ్లేషణ Ca²⁺ సమక్షంలో 37 °C వద్ద జరుగుతుంది (v = √2gh)';
      const res = validateTextScript(scientificTelugu, 'te');
      expect(res.isValid).toBe(true);
      expect(res.violations).toHaveLength(0);
    });
  });

  describe('Sanitizer', () => {
    it('should strip stray isolated foreign characters if required', () => {
      const text = 'సమతుల్య స్థితి (απότομη)';
      const { cleaned, wasSanitized } = sanitizeTextScript(text, 'te');
      expect(wasSanitized).toBe(true);
      expect(cleaned).toBe('సమతుల్య స్థితి ()');
    });
  });
});

