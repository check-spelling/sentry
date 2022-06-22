import {cloneElement, Component, Fragment, isValidElement} from 'react';
import {browserHistory, RouteComponentProps} from 'react-router';
import styled from '@emotion/styled';
import * as Sentry from '@sentry/react';
import * as PropTypes from 'prop-types';

import {Client} from 'sentry/api';
import LoadingError from 'sentry/components/loadingError';
import LoadingIndicator from 'sentry/components/loadingIndicator';
import PageFiltersContainer from 'sentry/components/organizations/pageFilters/container';
import MissingProjectMembership from 'sentry/components/projects/missingProjectMembership';
import SentryDocumentTitle from 'sentry/components/sentryDocumentTitle';
import {t} from 'sentry/locale';
import SentryTypes from 'sentry/sentryTypes';
import GroupStore from 'sentry/stores/groupStore';
import space from 'sentry/styles/space';
import {AvatarProject, Group, Organization, Project} from 'sentry/types';
import {Event} from 'sentry/types/event';
import trackAdvancedAnalyticsEvent from 'sentry/utils/analytics/trackAdvancedAnalyticsEvent';
import {callIfFunction} from 'sentry/utils/callIfFunction';
import {getUtcDateString} from 'sentry/utils/dates';
import {TableData} from 'sentry/utils/discover/discoverQuery';
import EventView from 'sentry/utils/discover/eventView';
import {doDiscoverQuery} from 'sentry/utils/discover/genericDiscoverQuery';
import {getMessage, getTitle} from 'sentry/utils/events';
import Projects from 'sentry/utils/projects';
import recreateRoute from 'sentry/utils/recreateRoute';
import withApi from 'sentry/utils/withApi';

import {ERROR_TYPES} from './constants';
import GroupHeader from './header';
import SampleEventAlert from './sampleEventAlert';
import {Tab} from './types';
import {
  fetchGroupEvent,
  getGroupReprocessingStatus,
  markEventSeen,
  ReprocessingStatus,
} from './utils';

type Error = typeof ERROR_TYPES[keyof typeof ERROR_TYPES] | null;

type Props = {
  api: Client;
  children: React.ReactNode;
  environments: string[];
  isGlobalSelectionReady: boolean;
  organization: Organization;
  projects: Project[];
} & RouteComponentProps<{groupId: string; orgId: string; eventId?: string}, {}>;

type State = {
  error: boolean;
  errorType: Error;
  eventError: boolean;
  group: Group | null;
  loading: boolean;
  loadingEvent: boolean;
  loadingGroup: boolean;
  loadingReplaysCount: boolean;
  project: null | (Pick<Project, 'id' | 'slug'> & Partial<Pick<Project, 'platform'>>);
  replaysCount: number | null;
  event?: Event;
};

class GroupDetails extends Component<Props, State> {
  static childContextTypes = {
    group: SentryTypes.Group,
    location: PropTypes.object,
  };

  state = this.initialState;

  getChildContext() {
    return {
      group: this.state.group,
      location: this.props.location,
    };
  }

  componentDidMount() {
    this.fetchData(true);
    this.fetchReplaysCount();
    this.updateReprocessingProgress();
  }

  componentDidUpdate(prevProps: Props, prevState: State) {
    const globalSelectionReadyChanged =
      prevProps.isGlobalSelectionReady !== this.props.isGlobalSelectionReady;

    if (
      globalSelectionReadyChanged ||
      prevProps.location.pathname !== this.props.location.pathname
    ) {
      // Skip tracking for other navigation events like switching events
      this.fetchData(globalSelectionReadyChanged);
    }

    if (
      (!this.canLoadEventEarly(prevProps) && !prevState?.group && this.state.group) ||
      (prevProps.params?.eventId !== this.props.params?.eventId && this.state.group)
    ) {
      this.getEvent(this.state.group);
    }
  }

  componentWillUnmount() {
    GroupStore.reset();
    callIfFunction(this.listener);
    if (this.refetchInterval) {
      window.clearInterval(this.refetchInterval);
    }
  }

  refetchInterval: number | null = null;

  get initialState(): State {
    return {
      group: null,
      loading: true,
      loadingEvent: true,
      loadingGroup: true,
      loadingReplaysCount: true,
      error: false,
      eventError: false,
      errorType: null,
      project: null,
      replaysCount: null,
    };
  }

  trackView(project: Project) {
    const {organization, params, location} = this.props;
    const {alert_date, alert_rule_id, alert_type} = location.query;
    trackAdvancedAnalyticsEvent('issue_details.viewed', {
      organization,
      project_id: parseInt(project.id, 10),
      group_id: parseInt(params.groupId, 10),
      // Alert properties track if the user came from email/slack alerts
      alert_date:
        typeof alert_date === 'string' ? getUtcDateString(Number(alert_date)) : undefined,
      alert_rule_id: typeof alert_rule_id === 'string' ? alert_rule_id : undefined,
      alert_type: typeof alert_type === 'string' ? alert_type : undefined,
    });
  }

  remountComponent = () => {
    this.setState(this.initialState);
    this.fetchData();
  };

  canLoadEventEarly(props: Props) {
    return !props.params.eventId || ['oldest', 'latest'].includes(props.params.eventId);
  }

  get groupDetailsEndpoint() {
    return `/issues/${this.props.params.groupId}/`;
  }

  get groupReleaseEndpoint() {
    return `/issues/${this.props.params.groupId}/first-last-release/`;
  }

  async getEvent(group?: Group) {
    if (group) {
      this.setState({loadingEvent: true, eventError: false});
    }

    const {params, environments, api} = this.props;
    const orgSlug = params.orgId;
    const groupId = params.groupId;
    const eventId = params?.eventId || 'latest';
    const projectId = group?.project?.slug;
    try {
      const event = await fetchGroupEvent(
        api,
        orgSlug,
        groupId,
        eventId,
        environments,
        projectId
      );
      this.setState({event, loading: false, eventError: false, loadingEvent: false});
    } catch (err) {
      // This is an expected error, capture to Sentry so that it is not considered as an unhandled error
      Sentry.captureException(err);
      this.setState({eventError: true, loading: false, loadingEvent: false});
    }
  }

  getCurrentRouteInfo(group: Group): {baseUrl: string; currentTab: Tab} {
    const {routes, organization} = this.props;
    const {event} = this.state;

    // All the routes under /organizations/:orgId/issues/:groupId have a defined props
    const {currentTab, isEventRoute} = routes[routes.length - 1].props as {
      currentTab: Tab;
      isEventRoute: boolean;
    };

    const baseUrl =
      isEventRoute && event
        ? `/organizations/${organization.slug}/issues/${group.id}/events/${event.id}/`
        : `/organizations/${organization.slug}/issues/${group.id}/`;

    return {currentTab, baseUrl};
  }

  updateReprocessingProgress() {
    const hasReprocessingV2Feature = this.hasReprocessingV2Feature();
    if (!hasReprocessingV2Feature) {
      return;
    }
    if (this.refetchInterval) {
      window.clearInterval(this.refetchInterval);
    }
    this.refetchInterval = window.setInterval(this.refetchGroup, 30000);
  }

  hasReprocessingV2Feature() {
    const {organization} = this.props;
    return organization.features?.includes('reprocessing-v2');
  }

  getReprocessingNewRoute(data: Group) {
    const {routes, location, params} = this.props;
    const {groupId} = params;

    const {id: nextGroupId} = data;

    const hasReprocessingV2Feature = this.hasReprocessingV2Feature();

    const reprocessingStatus = getGroupReprocessingStatus(data);
    const {currentTab, baseUrl} = this.getCurrentRouteInfo(data);

    if (groupId !== nextGroupId) {
      if (hasReprocessingV2Feature) {
        // Redirects to the Activities tab
        if (
          reprocessingStatus === ReprocessingStatus.REPROCESSED_AND_HASNT_EVENT &&
          currentTab !== Tab.ACTIVITY
        ) {
          return {
            pathname: `${baseUrl}${Tab.ACTIVITY}/`,
            query: {...params, groupId: nextGroupId},
          };
        }
      }

      return recreateRoute('', {
        routes,
        location,
        params: {...params, groupId: nextGroupId},
      });
    }

    if (hasReprocessingV2Feature) {
      if (
        reprocessingStatus === ReprocessingStatus.REPROCESSING &&
        currentTab !== Tab.DETAILS
      ) {
        return {
          pathname: baseUrl,
          query: params,
        };
      }

      if (
        reprocessingStatus === ReprocessingStatus.REPROCESSED_AND_HASNT_EVENT &&
        currentTab !== Tab.ACTIVITY &&
        currentTab !== Tab.USER_FEEDBACK
      ) {
        return {
          pathname: `${baseUrl}${Tab.ACTIVITY}/`,
          query: params,
        };
      }
    }

    return undefined;
  }

  getGroupQuery(): Record<string, string | string[]> {
    const {environments} = this.props;

    // Note, we do not want to include the environment key at all if there are no environments
    const query: Record<string, string | string[]> = {
      ...(environments ? {environment: environments} : {}),
      expand: 'inbox',
      collapse: 'release',
    };

    return query;
  }

  getFetchDataRequestErrorType(status: any): Error {
    if (!status) {
      return null;
    }

    if (status === 404) {
      return ERROR_TYPES.GROUP_NOT_FOUND;
    }

    if (status === 403) {
      return ERROR_TYPES.MISSING_MEMBERSHIP;
    }

    return null;
  }

  handleRequestError(error: any) {
    Sentry.captureException(error);
    const errorType = this.getFetchDataRequestErrorType(error?.status);

    this.setState({
      loadingGroup: false,
      loading: false,
      error: true,
      errorType,
    });
  }

  refetchGroup = async () => {
    const {loadingGroup, loading, loadingEvent, group} = this.state;

    if (
      group?.status !== ReprocessingStatus.REPROCESSING ||
      loadingGroup ||
      loading ||
      loadingEvent
    ) {
      return;
    }

    const {api} = this.props;

    this.setState({loadingGroup: true});

    try {
      const updatedGroup = await api.requestPromise(this.groupDetailsEndpoint, {
        query: this.getGroupQuery(),
      });

      const reprocessingNewRoute = this.getReprocessingNewRoute(updatedGroup);

      if (reprocessingNewRoute) {
        browserHistory.push(reprocessingNewRoute);
        return;
      }

      this.setState({group: updatedGroup, loadingGroup: false});
    } catch (error) {
      this.handleRequestError(error);
    }
  };

  async fetchGroupReleases() {
    const {api} = this.props;
    const releases = await api.requestPromise(this.groupReleaseEndpoint);
    GroupStore.onPopulateReleases(this.props.params.groupId, releases);
  }

  async fetchReplaysCount() {
    const {api, location, organization, params} = this.props;
    const {groupId} = params;

    this.setState({loadingReplaysCount: true});

    const eventView = EventView.fromSavedQuery({
      id: '',
      name: `Replays in issue ${groupId}`,
      version: 2,
      fields: ['count()'],
      query: `issue.id:${groupId}`,
      projects: [],
    });

    try {
      const [data] = await doDiscoverQuery<TableData>(
        api,
        `/organizations/${organization.slug}/events/`,
        eventView.getEventsAPIPayload(location)
      );

      const replaysCount = data.data[0]['count()'].toString();

      this.setState({
        replaysCount: parseInt(replaysCount, 10),
        loadingReplaysCount: false,
      });
    } catch (err) {
      this.setState({loadingReplaysCount: false});
    }
  }

  async fetchData(trackView = false) {
    const {api, isGlobalSelectionReady, params} = this.props;

    // Need to wait for global selection store to be ready before making request
    if (!isGlobalSelectionReady) {
      return;
    }

    try {
      const eventPromise = this.canLoadEventEarly(this.props)
        ? this.getEvent()
        : undefined;

      const groupPromise = await api.requestPromise(this.groupDetailsEndpoint, {
        query: this.getGroupQuery(),
      });

      const [data] = await Promise.all([groupPromise, eventPromise]);
      this.fetchGroupReleases();

      const reprocessingNewRoute = this.getReprocessingNewRoute(data);

      if (reprocessingNewRoute) {
        browserHistory.push(reprocessingNewRoute);
        return;
      }

      const project = data.project;

      markEventSeen(api, params.orgId, project.slug, params.groupId);

      if (!project) {
        Sentry.withScope(() => {
          Sentry.captureException(new Error('Project not found'));
        });
      } else {
        const locationWithProject = {...this.props.location};
        if (
          locationWithProject.query.project === undefined &&
          locationWithProject.query._allp === undefined
        ) {
          // We use _allp as a temporary measure to know they came from the
          // issue list page with no project selected (all projects included in
          // filter).
          //
          // If it is not defined, we add the locked project id to the URL
          // (this is because if someone navigates directly to an issue on
          // single-project privileges, then goes back - they were getting
          // assigned to the first project).
          //
          // If it is defined, we do not so that our back button will bring us
          // to the issue list page with no project selected instead of the
          // locked project.
          locationWithProject.query = {...locationWithProject.query, project: project.id};
        }
        // We delete _allp from the URL to keep the hack a bit cleaner, but
        // this is not an ideal solution and will ultimately be replaced with
        // something smarter.
        delete locationWithProject.query._allp;
        browserHistory.replace(locationWithProject);
      }

      this.setState({project, loadingGroup: false});

      GroupStore.loadInitialData([data]);

      if (trackView) {
        this.trackView(project);
      }
    } catch (error) {
      this.handleRequestError(error);
    }
  }

  listener = GroupStore.listen(itemIds => this.onGroupChange(itemIds), undefined);

  onGroupChange(itemIds: Set<string>) {
    const id = this.props.params.groupId;
    if (itemIds.has(id)) {
      const group = GroupStore.get(id) as Group;
      if (group) {
        // TODO(ts) This needs a better approach. issueActions is splicing attributes onto
        // group objects to cheat here.
        if ((group as Group & {stale?: boolean}).stale) {
          this.fetchData();
          return;
        }
        this.setState({
          group,
        });
      }
    }
  }

  getTitle() {
    const {organization} = this.props;
    const {group} = this.state;
    const defaultTitle = 'Sentry';

    if (!group) {
      return defaultTitle;
    }

    const {title} = getTitle(group, organization?.features);
    const message = getMessage(group);

    const {project} = group;
    const eventDetails = `${organization.slug} - ${project.slug}`;

    if (title && message) {
      return `${title}: ${message} - ${eventDetails}`;
    }

    return `${title || message || defaultTitle} - ${eventDetails}`;
  }

  renderError() {
    const {projects, location} = this.props;
    const projectId = location.query.project;

    const project = projects.find(proj => proj.id === projectId);

    switch (this.state.errorType) {
      case ERROR_TYPES.GROUP_NOT_FOUND:
        return (
          <StyledLoadingError
            message={t('The issue you were looking for was not found.')}
          />
        );

      case ERROR_TYPES.MISSING_MEMBERSHIP:
        return (
          <MissingProjectMembership
            organization={this.props.organization}
            project={project}
          />
        );
      default:
        return <StyledLoadingError onRetry={this.remountComponent} />;
    }
  }

  renderContent(project: AvatarProject, group: Group) {
    const {children, environments, organization} = this.props;
    const {loadingEvent, eventError, event, replaysCount} = this.state;

    const {currentTab, baseUrl} = this.getCurrentRouteInfo(group);
    const groupReprocessingStatus = getGroupReprocessingStatus(group);

    let childProps: Record<string, any> = {
      environments,
      group,
      project,
    };

    if (currentTab === Tab.DETAILS) {
      if (group.id !== event?.groupID && !eventError) {
        // if user pastes only the event id into the url, but it's from another group, redirect to correct group/event
        const redirectUrl = `/organizations/${organization.slug}/issues/${event?.groupID}/events/${event?.id}/`;
        this.props.router.push(redirectUrl);
      } else {
        childProps = {
          ...childProps,
          event,
          loadingEvent,
          eventError,
          groupReprocessingStatus,
          onRetry: () => this.remountComponent(),
        };
      }
    }

    if (currentTab === Tab.TAGS) {
      childProps = {...childProps, event, baseUrl};
    }

    return (
      <Fragment>
        <GroupHeader
          groupReprocessingStatus={groupReprocessingStatus}
          project={project as Project}
          event={event}
          group={group}
          replaysCount={replaysCount}
          currentTab={currentTab}
          baseUrl={baseUrl}
        />
        {isValidElement(children) ? cloneElement(children, childProps) : children}
      </Fragment>
    );
  }

  renderPageContent() {
    const {error: isError, group, project, loading} = this.state;
    const isLoading = loading || (!group && !isError);

    if (isLoading) {
      return <LoadingIndicator />;
    }

    if (isError) {
      return this.renderError();
    }

    const {organization} = this.props;

    return (
      <Projects
        orgId={organization.slug}
        slugs={[project?.slug ?? '']}
        data-test-id="group-projects-container"
      >
        {({projects, initiallyLoaded, fetchError}) =>
          initiallyLoaded ? (
            fetchError ? (
              <StyledLoadingError message={t('Error loading the specified project')} />
            ) : (
              // TODO(ts): Update renderContent function to deal with empty group
              this.renderContent(projects[0], group!)
            )
          ) : (
            <LoadingIndicator />
          )
        }
      </Projects>
    );
  }

  render() {
    const {project, group} = this.state;
    const {organization} = this.props;
    const isSampleError = group?.tags.some(tag => tag.key === 'sample_event');

    return (
      <Fragment>
        {isSampleError && project && (
          <SampleEventAlert project={project} organization={organization} />
        )}
        <SentryDocumentTitle noSuffix title={this.getTitle()}>
          <PageFiltersContainer
            skipLoadLastUsed
            forceProject={project}
            showDateSelector={false}
            shouldForceProject
            lockedMessageSubject={t('issue')}
            showIssueStreamLink
            showProjectSettingsLink
            hideGlobalHeader
          >
            {this.renderPageContent()}
          </PageFiltersContainer>
        </SentryDocumentTitle>
      </Fragment>
    );
  }
}

export default withApi(Sentry.withProfiler(GroupDetails));

const StyledLoadingError = styled(LoadingError)`
  margin: ${space(2)};
`;
