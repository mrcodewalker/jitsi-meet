import ReducerRegistry from '../base/redux/ReducerRegistry';
import meetingMode from './reducer';

ReducerRegistry.register('features/meeting-mode', meetingMode);

export * from './actions';
export * from './actionTypes';