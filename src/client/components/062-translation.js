// @flow

import React                from 'react';
import Relay                from 'react-relay';
import MessageFormat        from 'messageformat';
import { mainStory }        from 'storyboard';
import {
  cancelEvent,
  Icon, Textarea,
  KEYS,
  hoverable,
}                           from 'giu';
import type {
  KeyT,
  TranslationT,
  RelayContainer,
  HoverablePropsT,
}                           from '../../common/types';
import _t                   from '../../translate';
import {
  CreateTranslationMutation,
  UpdateTranslationMutation,
  DeleteTranslationMutation,
}                           from '../gral/mutations';
import { COLORS }           from '../gral/constants';
import { mutate }           from './helpers';

const validateTranslation = (lang: string) => (val: string) => {
  const numOpen = val.split('{').length - 1;
  const numClose = val.split('}').length - 1;
  if (numOpen !== numClose) {
    return _t('validation_the number of left and right brackets does not match');
  }
  const mf = new MessageFormat(lang).setIntlSupport(true);
  try {
    mf.compile(val);
  } catch (err) {
    const msg = _t('validation_MessageFormat syntax error');
    return `${msg}: ${err.message}`;
  }
  return undefined;
};

// ==========================================
// Component declarations
// ==========================================
const fragments = {
  theKey: () => Relay.QL`
    fragment on Key {
      id
      text
    }
  `,
  translation: () => Relay.QL`
    fragment on Translation {
      id
      lang, translation, fuzzy
    }
  `,
};

type PublicPropsT = {
  theKey: KeyT,
  lang: string,
  translation: ?TranslationT,
  changeSelectedKey: (keyId: ?string) => void,
};
type PropsT = PublicPropsT & HoverablePropsT;

// ==========================================
// Component
// ==========================================
class Translation extends React.Component {
  props: PropsT;
  state: {
    fEditing: boolean,
    fDismissedHelp: boolean,
    cmds: Array<Object>,
  };
  refInput: ?Object;

  constructor(props: PropsT) {
    super(props);
    this.state = {
      fEditing: false,
      fDismissedHelp: false,
      cmds: [],
    };
  }

  // ------------------------------------------
  // Render
  // ------------------------------------------
  render() {
    return (
      <div
        onMouseEnter={this.props.onHoverStart}
        onMouseLeave={this.props.onHoverStop}
        style={style.outer}
      >
        {this.renderTranslation()}
        {this.renderButtons()}
        {this.renderHelp()}
      </div>
    );
  }

  renderTranslation() {
    const { lang, translation } = this.props;
    const { cmds } = this.state;
    // const fUpdating = translation && relay.hasOptimisticUpdate(translation);
    return (
      <Textarea ref={(c) => { this.refInput = c; }}
        value={translation ? translation.translation : null}
        validators={[validateTranslation(lang)]}
        onFocus={this.onFocus}
        onBlur={this.onBlur}
        onKeyDown={this.onKeyDown}
        onKeyUp={this.onKeyUp}
        cmds={cmds}
        style={style.textareaBase(this.state)}
      />
    );
  }

  renderButtons() {
    const { translation } = this.props;
    const interactedWith = this.state.fEditing || this.props.hovering;
    const elFuzzy = translation && (interactedWith || translation.fuzzy)
      ? (
        <Icon
          icon="warning"
          title={_t('tooltip_Dubious translation (click to toggle)')}
          onClick={translation ? this.onClickFuzzy : undefined}
          style={style.iconFuzzy({ button: interactedWith, active: translation.fuzzy })}
        />
      )
      : null;
    if (!interactedWith) return elFuzzy ? <div style={style.buttons}>{elFuzzy}</div> : null;
    const elDelete = translation
      ? (<Icon
          icon="remove"
          title={_t('tooltip_Delete translation')}
          onClick={this.onClickDelete}
          style={style.iconButton}
        />)
      : null;
    return (
      <div style={style.buttons}>
        <Icon
          icon="copy"
          title={_t('tooltip_Copy message')}
          onMouseDown={this.onMouseDownCopyKey}
          style={style.iconButton}
        />
        {elDelete}
        {elFuzzy}
      </div>
    );
  }

  renderHelp() {
    if (!this.state.fEditing || this.state.fDismissedHelp) return null;
    return (
      <div onMouseEnter={this.onHoverHelp} style={style.help}>
        {_t('translationHelp_Click outside or TAB to save. ESC to undo.')}
      </div>
    );
  }

  // ------------------------------------------
  // Handlers
  // ------------------------------------------
  onFocus = () => {
    this.setState({ fEditing: true, fDismissedHelp: false });
    this.props.changeSelectedKey(this.props.theKey.id);
  }

  // RETURN + modifier key (unmodified RETURNs are accepted in the textarea): ignore (will
  // be processed on keyup)
  onKeyDown = (ev: SyntheticKeyboardEvent) => {
    if (ev.which === KEYS.enter &&
        (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey)) {
      cancelEvent(ev);
    }
  }

  // ESC: revert and blur
  // RETURN + modifier key (unmodified RETURNs are accepted in the textarea): blur (and save)
  onKeyUp = (ev: SyntheticKeyboardEvent) => {
    if (ev.which === KEYS.esc) {
      this.setState({ cmds: [{ type: 'REVERT' }, { type: 'BLUR' }] });
    } else if (ev.which === KEYS.enter &&
               (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey)) {
      this.setState({ cmds: [{ type: 'BLUR' }] });
    }
  }

  onBlur = () => {
    this.setState({ fEditing: false });
    if (!this.refInput) {
      mainStory.warn('translation', 'Could not save translation');
      return;
    }
    this.refInput.validateAndGetValue()
    .then((text) => {
      if (text === this.getInitialTranslation()) return;
      const description = 'Commit translation edit';
      let Mutation;
      let props;
      if (this.props.translation) {
        Mutation = UpdateTranslationMutation;
        props = {
          id: this.props.translation.id,
          set: {
            translation: text,
          },
        };
      } else {
        Mutation = CreateTranslationMutation;
        props = {
          set: {
            lang: this.props.lang,
            keyId: this.props.theKey.id,
            translation: text,
          },
          keyId: this.props.theKey.id,
        };
      }
      mutate({ description, Mutation, props });
    });
  }

  onMouseDownCopyKey = () => {
    this.setState({
      cmds: [
        { type: 'SET_VALUE', value: this.props.theKey.text },
        { type: 'FOCUS' },
      ],
    });
  }

  onClickDelete = () => {
    if (!this.props.translation) return;
    mutate({
      description: 'Click on Delete translation',
      Mutation: DeleteTranslationMutation,
      props: {
        id: this.props.translation.id,
        keyId: this.props.theKey.id,
      },
    });
  }

  onClickFuzzy = () => {
    if (!this.props.translation) return;
    mutate({
      description: 'Toggle translation fuzziness',
      Mutation: UpdateTranslationMutation,
      props: {
        id: this.props.translation.id,
        set: { fuzzy: !this.props.translation.fuzzy },
      },
    });
  }

  onHoverHelp = () => {
    this.setState({ fDismissedHelp: true });
  }

  // ------------------------------------------
  // Helpers
  // ------------------------------------------
  getInitialTranslation(props?: PropsT) {
    const finalProps = props || this.props;
    return finalProps.translation ? finalProps.translation.translation : null;
  }
}

// ------------------------------------------
// Styles
// ------------------------------------------
const style = {
  outer: {
    paddingRight: 56,
    marginBottom: -2,
    position: 'relative',
  },
  textareaBase: ({ fEditing }) => ({
    padding: 0,
    border: '1px solid transparent',
    backgroundColor: fEditing ? undefined : 'transparent',
    minHeight: 17,
  }),
  buttons: {
    position: 'absolute',
    top: 1,
    right: 5,
    color: 'black',
  },
  iconButton: {
    marginLeft: 5,
  },
  iconFuzzy: ({ button, active }) => ({
    marginLeft: 5,
    color: button
      ? (active ? 'black' : COLORS.dim)
      : 'orange',
  }),
  help: {
    position: 'absolute',
    bottom: '100%',
    right: -5,
    margin: '0 0 2px 0',
    padding: '0px 4px',
    background: COLORS.darkest,
    maxWidth: 190,
    fontSize: '0.9em',
    color: 'white',
    textAlign: 'right',
  },
};

// ==========================================
// Public API
// ==========================================
const HoverableTranslation = hoverable(Translation);
const Container: RelayContainer<{}, PublicPropsT, any> =
  Relay.createContainer(HoverableTranslation, { fragments });
export default Container;
export { HoverableTranslation as _HoverableTranslation };
