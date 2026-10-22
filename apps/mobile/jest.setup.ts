// Runs before every test file (setupFilesAfterEnv), where no per-test timeout applies.
//
// React Native exposes its components through lazy getters, so a suite's first render is also the
// first require of the components it uses. On a cold Jest cache that means transforming them with
// Babel inside the first test: ScrollView alone takes about 3.4 s on this machine and Text 1.3 s.
// Under CPU contention (`pnpm -r test`) the first test exceeded Jest's 5 s timeout (#140). Touching
// the getters here moves that one-time cost out of the tests.
//
// It loads the real modules into the test file's registry. A `jest.mock` of one of them in a test
// file still replaces it for later requires, but anything that captured the real module during this
// setup keeps it: mock these components where the test owns the boundary, not around them.
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

void [ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View];
