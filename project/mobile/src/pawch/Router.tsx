import { useApp } from '../state/AppContext';
import { PawchOnboardingScreen } from './OnboardingFlow';
import { PawchWellbeingScreen } from './WellbeingFlow';
import { PawchNutritionScreen } from './NutritionFlow';
import { PawchCareScreen } from './CareFlow';
import { PawchSafetyScreen } from './SafetyFlow';
import { PawchBehaviorScreen } from './BehaviorFlow';
import { PawchLearnScreen } from './LearnFlow';
import { FlowProps } from './data';

export const publicScreenIds = new Set(['01', '02', '06']);
export const screenIds = [...Array.from({ length: 51 }, (_, index) => String(index + 1).padStart(2, '0')), '15a', '15b', '15c', '20a', '20b', '20c', '38a', '38b', '38c', '44a', '44b', '44c', '44d', '44e'];
export const isScreenId = (id: unknown): id is string => typeof id === 'string' && screenIds.includes(id);
export function PawchRouter(props: FlowProps) {
  const { authenticated } = useApp(), id = isScreenId(props.screenId) ? props.screenId : '09';
  if (!authenticated && !publicScreenIds.has(id)) return <PawchOnboardingScreen {...props} screenId="06" />;
  const number = parseInt(id, 10), args = { ...props, screenId: id, params: props.route?.params ?? props.params ?? {} };
  const sourceKey = JSON.stringify([id, ...['recordId', 'taskId', 'mediaId', 'contentId', 'contentVersion', 'conversationId', 'observationId', 'evidenceId', 'lessonId', 'lessonVersion', 'petId', 'date', 'newPet', 'demo'].map(name => args.params[name]), args.params.from === '08']);
  if (number <= 8) return <PawchOnboardingScreen key={sourceKey} {...args} />;
  if (number <= 17) return <PawchWellbeingScreen key={sourceKey} {...args} />;
  if (number <= 23) return <PawchNutritionScreen key={sourceKey} {...args} />;
  if (number <= 27) return <PawchCareScreen key={sourceKey} {...args} />;
  if (number <= 39) return <PawchSafetyScreen key={sourceKey} {...args} />;
  if (number <= 47) return <PawchBehaviorScreen key={sourceKey} {...args} />;
  return <PawchLearnScreen key={sourceKey} {...args} />;
}
