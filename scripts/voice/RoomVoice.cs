using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Text;

// Windows speech engine helper for generate.py. Text arguments come from UTF-8
// files so the console code page never touches them.
public static class RoomVoice
{
    // One line per word: the word, a tab, then its SAPI phone IDs.
    public static string Phonemes(string voice, string wordsPath)
    {
        var output = new StringBuilder();
        var current = new List<int>();
        using (var synthesizer = new SpeechSynthesizer())
        {
            synthesizer.SelectVoice(voice);
            synthesizer.SetOutputToNull();
            synthesizer.PhonemeReached += (sender, e) => { foreach (var c in e.Phoneme) current.Add(c); };
            foreach (var word in File.ReadAllLines(wordsPath, Encoding.UTF8))
            {
                if (word.Trim().Length == 0) continue;
                current.Clear();
                synthesizer.Speak(word);
                output.Append(word).Append('\t').Append(string.Join(" ", current)).Append('\n');
            }
        }
        return output.ToString();
    }

    public static void Speak(string voice, string textPath, string wav, int rate)
    {
        using (var synthesizer = new SpeechSynthesizer())
        {
            synthesizer.SelectVoice(voice);
            synthesizer.Rate = rate;
            synthesizer.SetOutputToWaveFile(wav);
            synthesizer.Speak(File.ReadAllText(textPath, Encoding.UTF8));
        }
    }

    // Space-separated IPA words, each spoken through a pronunciation override;
    // a lone "|" is the pause of a comma.
    public static void SpeakIpa(string voice, string ipaPath, string wav, int rate)
    {
        using (var synthesizer = new SpeechSynthesizer())
        {
            synthesizer.SelectVoice(voice);
            synthesizer.Rate = rate;
            synthesizer.SetOutputToWaveFile(wav);
            var prompt = new PromptBuilder();
            foreach (var word in File.ReadAllText(ipaPath, Encoding.UTF8).Split(new[] { ' ', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (word == "|") prompt.AppendBreak(TimeSpan.FromMilliseconds(260));
                else prompt.AppendTextWithPronunciation("x", word);
            }
            synthesizer.Speak(prompt);
        }
    }

    // The candidate line the offline recogniser finds closest, never rejecting.
    public static string Recognize(string culture, string wav, string choicesPath)
    {
        using (var recognizer = new SpeechRecognitionEngine(new CultureInfo(culture)))
        {
            var builder = new GrammarBuilder(new Choices(File.ReadAllLines(choicesPath, Encoding.UTF8)));
            builder.Culture = recognizer.RecognizerInfo.Culture;
            recognizer.LoadGrammar(new Grammar(builder));
            recognizer.UpdateRecognizerSetting("CFGConfidenceRejectionThreshold", 0);
            // A comma's pause must not end the utterance before the line does.
            recognizer.EndSilenceTimeout = TimeSpan.FromSeconds(1.5);
            recognizer.EndSilenceTimeoutAmbiguous = TimeSpan.FromSeconds(1.5);
            recognizer.SetInputToWaveFile(wav);
            var result = recognizer.Recognize();
            return result == null ? "\t0" : result.Text + "\t" + result.Confidence.ToString("0.000", CultureInfo.InvariantCulture);
        }
    }
}
