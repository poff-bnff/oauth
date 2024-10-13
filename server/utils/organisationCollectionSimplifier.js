export async function simplifyOrganisationCollection(organisation, user) {
    if (organisation.filmographies.length) {
      const filmographiesIds = organisation.filmographies.map(function (element) {
        return element.id;
      });

      const filmographies = await getStrapiFilmographies(filmographiesIds)
      organisation.filmographies = formatFilmographies(filmographies)
    }
    if (organisation.clients.length) {
      const clientIds = organisation.clients.map(function (client) {
        return client.id;
      });

      const clients = await getStrapiClients(clientIds)
      organisation.clients = formatClients(clients)
    }
    organisation.people = organisation.people.map(people => people.id)
    organisation.languages = organisation.languages.map(language => language.id)
    organisation.role_at_films = organisation.role_at_films.map(role_at_film => role_at_film.id)
    organisation.ok_to_contact = okToContact(organisation, user)
    return organisation
  }

function okToContact (organisation, sessionUser) {
    const freshUser = organisation.users.find(user => sessionUser.id == user.id);
    if (freshUser) {
        console.log('Yes freshuser')
        return freshUser.ok_to_contact
    }
    return sessionUser.ok_to_contact
}

function formatClients(clients) {
    return clients.map(client => {
        return {
            id: client.id,
            name: client.client_organisation.namePrivate,
            description: client.description,
            url: client.url
        }
    })
}

function formatFilmographies(filmographies) {
    return filmographies.map(filmography => {
        return {
            id: filmography.id,
            work_name: filmography.work_name,
            work_url: filmography.work_url,
            decsription_en: filmography.decsription_en,
            org_name: filmography.org_name,
            org_url: filmography.org_url,
            runtime: filmography.runtime,
            year_from: filmography.year_from,
            year_to: filmography.year_to,
            url: filmography.url,
            type_of_work: filmography.type_of_work,
            is_featured: filmography.is_featured,
            type_of_work: filmography.type_of_work?.id,
            role_at_films: filmography.role_at_films.map(role_at_film => role_at_film.id),
            project_statuses: filmography.project_statuses.map(project_status => project_status.id),
            tag_looking_fors: filmography.tag_looking_fors.map(tag_looking_for => tag_looking_for.id),
            stills: filmography.stills.map(still => { return {id: still.id, hash: still.hash, ext: still.ext} })
        }
    })
}
