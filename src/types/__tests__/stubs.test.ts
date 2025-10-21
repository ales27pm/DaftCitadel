import {
  useSharedValue,
  runOnJS,
  useAnimatedScrollHandler,
} from '../stubs/react-native-reanimated';
import { Skia } from '../stubs/shopify-react-native-skia';
import { createNativeStackNavigator } from '../stubs/react-navigation-native-stack';
import { createBottomTabNavigator } from '../stubs/react-navigation-bottom-tabs';

describe('react-native-reanimated stub', () => {
  it('provides shared value containers', () => {
    const shared = useSharedValue(5);
    expect(shared.value).toBe(5);
  });

  it('executes runOnJS callbacks', () => {
    const spy = jest.fn();
    const wrapped = runOnJS(spy);
    wrapped('payload');
    expect(spy).toHaveBeenCalledWith('payload');
  });

  it('supports scroll handler registration', () => {
    const handler = useAnimatedScrollHandler({ onScroll: jest.fn() });
    expect(typeof handler).toBe('function');
  });
});

describe('skia stub', () => {
  it('records path commands', () => {
    const path = Skia.Path.Make();
    path.moveTo(0, 0);
    path.lineTo(10, 10);
    path.close();
    expect(path.toCmds()).toEqual(['M0,0', 'L10,10', 'Z']);
  });
});

describe('navigation stubs', () => {
  it('creates stack navigator components', () => {
    const stack = createNativeStackNavigator();
    expect(stack.Navigator).toBeDefined();
    expect(stack.Screen).toBeDefined();
  });

  it('creates bottom tab navigator components', () => {
    const tabs = createBottomTabNavigator();
    expect(tabs.Navigator).toBeDefined();
    expect(tabs.Screen).toBeDefined();
  });
});
