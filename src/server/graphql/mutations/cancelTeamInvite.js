import {GraphQLID, GraphQLNonNull} from 'graphql';
import getRethink from 'server/database/rethinkDriver';
import CancelTeamInvitePayload from 'server/graphql/types/CancelTeamInvitePayload';
import {requireTeamMember} from 'server/utils/authorization';
import getPubSub from 'server/utils/getPubSub';
import {INVITATION, NOTIFICATION, REMOVED, TEAM_INVITE} from 'universal/utils/constants';


export default {
  name: 'CancelTeamInvite',
  type: CancelTeamInvitePayload,
  description: 'Cancel an invitation',
  args: {
    invitationId: {
      type: new GraphQLNonNull(GraphQLID),
      description: 'The id of the invitation'
    }
  },
  async resolve(source, {invitationId}, {authToken, dataLoader, socketId: mutatorId}) {
    const r = getRethink();
    const now = new Date();
    const operationId = dataLoader.share();
    const subOptions = {mutatorId, operationId};

    // AUTH
    const {email, teamId} = await r.table('Invitation').get(invitationId).default({});
    if (!teamId) {
      throw new Error('Invitation not found!');
    }
    requireTeamMember(authToken, teamId);

    // RESOLUTION
    const {removedTeamInviteNotification} = await r({
      invitation: r.table('Invitation').get(invitationId).update({
        // set expiration to epoch
        tokenExpiration: new Date(0),
        updatedAt: now
      }),
      orgApproval: r.table('OrgApproval')
        .getAll(email, {index: 'email'})
        .filter({teamId})
        .update({
          isActive: false
        }),
      removedTeamInviteNotification: r.table('User')
        .getAll(email, {index: 'email'})
        .nth(0)('id').default(null)
        .do((userId) => {
          return r.table('Notification')
            .getAll(userId, {index: 'userIds'})
            .filter({
              type: TEAM_INVITE,
              teamId
            })
            .delete({returnChanges: true})('changes')(0)('old_val')
            .default(null);
        })
    });
    getPubSub().publish(`${INVITATION}.${teamId}`, {data: {invitationId, type: REMOVED}, ...subOptions});
    if (removedTeamInviteNotification) {
      const {userIds: [userId]} = removedTeamInviteNotification;
      getPubSub().publish(`${NOTIFICATION}.${userId}`, {
        data: {
          type: REMOVED,
          notification: removedTeamInviteNotification
        },
        ...subOptions
      });
    }
    return {invitationId};
  }
};
