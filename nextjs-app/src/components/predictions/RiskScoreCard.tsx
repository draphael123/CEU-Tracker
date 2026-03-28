import type { RiskLevel, RiskFactor } from '@/types';

interface RiskScoreCardProps {
  score: number;
  level: RiskLevel;
  factors?: RiskFactor[];
  showDetails?: boolean;
}

const levelColors: Record<RiskLevel, { bg: string; text: string; ring: string }> = {
  low: { bg: 'bg-green-50', text: 'text-green-700', ring: 'ring-green-500' },
  medium: { bg: 'bg-amber-50', text: 'text-amber-700', ring: 'ring-amber-500' },
  high: { bg: 'bg-orange-50', text: 'text-orange-700', ring: 'ring-orange-500' },
  critical: { bg: 'bg-red-50', text: 'text-red-700', ring: 'ring-red-500' },
};

const levelLabels: Record<RiskLevel, string> = {
  low: 'Low Risk',
  medium: 'Medium Risk',
  high: 'High Risk',
  critical: 'Critical Risk',
};

export function RiskScoreCard({ score, level, factors, showDetails = true }: RiskScoreCardProps) {
  const colors = levelColors[level];

  // Calculate gauge rotation (0-100 score maps to 0-180 degrees)
  const rotation = (score / 100) * 180;

  return (
    <div className={`rounded-xl p-4 ${colors.bg}`}>
      {/* Score display */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className={`text-3xl font-bold ${colors.text}`}>{score}</div>
          <div className={`text-sm font-medium ${colors.text}`}>{levelLabels[level]}</div>
        </div>

        {/* Visual gauge */}
        <div className="relative w-20 h-10 overflow-hidden">
          <div className="absolute bottom-0 left-0 right-0 h-20 rounded-full border-8 border-gray-200" />
          <div
            className={`absolute bottom-0 left-0 right-0 h-20 rounded-full border-8 ${colors.ring.replace('ring', 'border')}`}
            style={{
              clipPath: `polygon(0 100%, 50% 100%, 50% 0, ${50 + Math.sin((rotation * Math.PI) / 180) * 50}% ${100 - Math.cos((rotation * Math.PI) / 180) * 100}%, 0 100%)`,
            }}
          />
          <div
            className={`absolute bottom-0 left-1/2 w-1 h-8 -ml-0.5 origin-bottom ${colors.text.replace('text', 'bg')}`}
            style={{ transform: `rotate(${rotation - 90}deg)` }}
          />
        </div>
      </div>

      {/* Risk factors breakdown */}
      {showDetails && factors && factors.length > 0 && (
        <div className="space-y-2 pt-3 border-t border-gray-200/50">
          {factors.map((factor) => (
            <div key={factor.name} className="flex items-center justify-between text-sm">
              <span className="text-gray-600">{factor.name}</span>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${getFactorColor(factor.score, factor.maxScore)}`}
                    style={{ width: `${(factor.score / factor.maxScore) * 100}%` }}
                  />
                </div>
                <span className="text-gray-500 w-8 text-right">
                  {factor.score}/{factor.maxScore}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function getFactorColor(score: number, maxScore: number): string {
  const ratio = score / maxScore;
  if (ratio < 0.25) return 'bg-green-500';
  if (ratio < 0.5) return 'bg-amber-500';
  if (ratio < 0.75) return 'bg-orange-500';
  return 'bg-red-500';
}
