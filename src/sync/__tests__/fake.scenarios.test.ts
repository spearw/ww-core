import { makeFakeWorld } from './fakeWorld';
import { runScenarios } from './scenarios';

runScenarios('fake server', () => makeFakeWorld());
