// Runs before every test file (setupFilesAfterEnv), where no per-test timeout applies.
//
// React Native exposes its components through lazy getters, so a suite's first render is also the
// first require of the components it uses. On a cold Jest cache that means transforming them with
// Babel inside the first test: ScrollView alone takes about 3.4 s on this machine, Text 1.3 s and
// Modal (which Testing Library renders to learn the host component names) 1.4 s. Under CPU
// contention (`pnpm -r test`) the first test exceeded Jest's 5 s timeout (#140). Touching the
// getters here moves that one-time cost out of the tests; it loads the real modules, so mocks
// declared in test files still apply the same way.
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

void [
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
];
